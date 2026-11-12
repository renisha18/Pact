// Pure candidate filter: no AI, no DB. All amounts are integer cents.
// The facts it returns are safe to show the whole group or hand to the AI:
// they never contain budget numbers, names or member text.
import { equalSplit } from './equalSplit.js';

const AMENITY_PHRASES = {
  pool: 'has a pool',
  kitchen: 'has a kitchen',
  'vegetarian kitchen': 'has a vegetarian kitchen',
  'step-free access': 'has step-free access',
  wifi: 'has wifi',
  'air conditioning': 'has air conditioning',
};

const ROOM_TYPE_PHRASES = {
  private_rooms: 'private rooms',
  shared_rooms: 'shared rooms',
  mixed_dorm: 'a mixed dorm',
};

const amenityPhrase = (a) => AMENITY_PHRASES[a] ?? `has ${a}`;

/** Room type of an avoid entry: {type, strength} or a legacy plain string. */
export const avoidType = (a) => (typeof a === 'string' ? a : a.type);

const EMPTY = { hardRequirements: [], avoidRoomTypes: [], softPreferences: [] };

/**
 * Consent overrides apply ONLY to their own listing.
 *   budget:    this member's cap for that listing = accepted_max_share_cents
 *   room_type: that 'preferred' avoid is lifted for that listing only; the cap there is
 *              min(original cap, accepted share). 'strict' avoids are never lifted.
 * @param {{capCents:number, overrides?:Array<{listingId:number, kind:'budget'|'room_type', maxShareCents:number|null, roomType:string|null}>}} m
 */
const overridesFor = (m, listingId) => (m.overrides ?? []).filter((o) => o.listingId === listingId);

export function capForListing(m, listingId) {
  let cap = m.capCents;
  const own = overridesFor(m, listingId);
  const budget = own.filter((o) => o.kind === 'budget');
  if (budget.length > 0) cap = Math.min(...budget.map((o) => o.maxShareCents));
  for (const o of own) if (o.kind === 'room_type' && Number.isInteger(o.maxShareCents)) cap = Math.min(cap, o.maxShareCents);
  return cap;
}

/**
 * Equal split of a listing's total, and whether it is affordable: every member's equal share
 * must be <= their budget for that listing (their private budget, or the share they accepted
 * through an active consent override for it).
 * @returns {{feasible: boolean, shares: Array<{userId:number, amountCents:number}>}}
 */
export function splitFor(totalCents, members, listingId) {
  const { shares } = equalSplit(totalCents, members);
  const feasible = shares.every((s) => s.amountCents <= capForListing(members.find((m) => m.userId === s.userId), listingId));
  return { feasible, shares };
}

/** Room types this member avoids AT this listing (preferred avoids lifted by an override for it). */
function avoidedAt(m, p, listingId) {
  const lifted = new Set(overridesFor(m, listingId).filter((o) => o.kind === 'room_type').map((o) => o.roomType));
  return p.avoidRoomTypes
    .filter((a) => !(typeof a !== 'string' && a.strength === 'preferred' && lifted.has(a.type)))
    .map(avoidType);
}

function assertPositiveInt(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
}

/**
 * @param {Array<{id:number, price_per_night_cents:number, max_guests:number, room_type:string, amenities:string[], vibe_tags:string[]}>} listings
 * @param {Array<{userId:number, capCents:number, extracted?: {hardRequirements:string[], avoidRoomTypes:Array<{type:string, strength:'strict'|'preferred'}|string>, softPreferences:string[]} | null,
 *   overrides?: Array<{listingId:number, kind:'budget'|'room_type', maxShareCents:number|null, roomType:string|null}>}>} members
 * @param {number} nights
 * @param {number} groupSize
 * @returns {Array<{listingId:number, totalCents:number, softMatchCount:number, facts:string[]}>}
 */
export function filterListings(listings, members, nights, groupSize) {
  assertPositiveInt(nights, 'nights');
  assertPositiveInt(groupSize, 'groupSize');
  if (!Array.isArray(members) || members.length === 0) throw new TypeError('members must be a non-empty array');

  const prefs = members.map((m) => ({ ...EMPTY, ...(m.extracted ?? {}) }));
  const required = new Set(prefs.flatMap((p) => p.hardRequirements));

  const candidates = [];
  for (const listing of listings) {
    if (listing.max_guests < groupSize) continue;
    // Both 'strict' and 'preferred' avoids exclude. Plain strings (old cache) count as strict.
    if (members.some((m, i) => avoidedAt(m, prefs[i], listing.id).includes(listing.room_type))) continue;

    const features = new Set([...(listing.amenities ?? []), ...(listing.vibe_tags ?? [])]);
    if ([...required].some((r) => !features.has(r))) continue;

    const totalCents = listing.price_per_night_cents * nights;
    if (!splitFor(totalCents, members, listing.id).feasible) continue;

    const softMatchCount = prefs.reduce(
      (sum, p) => sum + p.softPreferences.filter((s) => features.has(s)).length,
      0,
    );

    const facts = [
      "fits everyone's budget",
      'has room for the whole group',
      ...(required.size > 0 ? ["meets everyone's must-haves"] : []),
      ...(softMatchCount > 0
        ? [`matches ${softMatchCount} of the group's wishes`]
        : []),
      `has ${ROOM_TYPE_PHRASES[listing.room_type] ?? listing.room_type}`,
      ...(listing.amenities ?? []).map(amenityPhrase),
    ];

    candidates.push({ listingId: listing.id, totalCents, softMatchCount, facts });
  }

  return candidates.sort(
    (a, b) => b.softMatchCount - a.softMatchCount || a.totalCents - b.totalCents || a.listingId - b.listingId,
  );
}
