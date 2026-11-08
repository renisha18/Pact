// Pure candidate filter: no AI, no DB. All amounts are integer cents.
// The facts it returns are safe to show the whole group or hand to the AI:
// they never contain budget numbers, names or member text.
import { fairSplit } from './fairSplit.js';

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

const EMPTY = { hardRequirements: [], avoidRoomTypes: [], softPreferences: [] };

function assertPositiveInt(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
}

/**
 * @param {Array<{id:number, price_per_night_cents:number, max_guests:number, room_type:string, amenities:string[], vibe_tags:string[]}>} listings
 * @param {Array<{userId:number, capCents:number, extracted?: {hardRequirements:string[], avoidRoomTypes:string[], softPreferences:string[]} | null}>} members
 * @param {number} nights
 * @param {number} groupSize
 * @returns {Array<{listingId:number, totalCents:number, softMatchCount:number, facts:string[]}>}
 */
export function filterListings(listings, members, nights, groupSize) {
  assertPositiveInt(nights, 'nights');
  assertPositiveInt(groupSize, 'groupSize');
  if (!Array.isArray(members) || members.length === 0) throw new TypeError('members must be a non-empty array');

  const prefs = members.map((m) => ({ ...EMPTY, ...(m.extracted ?? {}) }));
  const avoided = new Set(prefs.flatMap((p) => p.avoidRoomTypes));
  const required = new Set(prefs.flatMap((p) => p.hardRequirements));
  const caps = members.map((m) => ({ userId: m.userId, capCents: m.capCents }));

  const candidates = [];
  for (const listing of listings) {
    if (listing.max_guests < groupSize) continue;
    if (avoided.has(listing.room_type)) continue;

    const features = new Set([...(listing.amenities ?? []), ...(listing.vibe_tags ?? [])]);
    if ([...required].some((r) => !features.has(r))) continue;

    const totalCents = listing.price_per_night_cents * nights;
    if (!fairSplit(totalCents, caps).feasible) continue;

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
