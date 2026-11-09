// Pure "what would unlock a stay?" search: no AI, no DB. All amounts are integer cents.
// Runs only when filterListings finds nothing, and tries ONE change at a time:
//   a. group:  fewer nights
//   b. member: drop one 'preferred' avoided room type
//   c. member: raise their budget cap (rounded up to $5)
// It never touches 'strict' avoids or hard requirements (both come from comfort_text).
// Member-scoped options carry private numbers: route each one ONLY to its userId.
import { filterListings, avoidType, capsForListing } from './filterListings.js';
import { fairSplit } from './fairSplit.js';

const ROUND_CENTS = 500;
const roundUp = (cents) => Math.ceil(cents / ROUND_CENTS) * ROUND_CENTS;

const EMPTY = { hardRequirements: [], avoidRoomTypes: [], softPreferences: [] };
const prefsOf = (m) => ({ ...EMPTY, ...(m.extracted ?? {}) });

function shareFor(totalCents, members, userId, listingId) {
  const split = fairSplit(totalCents, capsForListing(members, listingId));
  return split.shares.find((s) => s.userId === userId).amountCents;
}

function memberOption(members, userId, change, cost, candidates, listingsById, top = candidates[0]) {
  // The unlocked listing we describe: filterListings' top pick unless told otherwise.
  const listing = listingsById.get(top.listingId);
  const features = new Set([...(listing.amenities ?? []), ...(listing.vibe_tags ?? [])]);
  const own = prefsOf(members.find((m) => m.userId === userId));
  return {
    scope: 'member',
    userId,
    change,
    unlockedListingIds: candidates.map((c) => c.listingId),
    listingId: top.listingId, // the unlocked stay newShareCents/matchesOwnWishes describe
    newShareCents: shareFor(top.totalCents, members, userId, top.listingId),
    matchesOwnWishes: own.softPreferences.filter((s) => features.has(s)),
    cost,
  };
}

/**
 * @param listings  same shape as filterListings
 * @param members   same shape as filterListings
 * @returns {Array<{scope:'group'|'member', userId?:number, change:object, unlockedListingIds:number[],
 *   listingId?:number, newShareCents?:number, matchesOwnWishes?:string[]}>} sorted smallest change first; [] if
 *   there are already candidates or nothing single-step helps.
 *
 * "Smallest change" = fraction of what's being given up: nights dropped / nights,
 * budget raise / that member's cap, and a flat 0.25 for letting go of one preferred avoid.
 */
export function counterfactual(listings, members, nights, groupSize) {
  if (filterListings(listings, members, nights, groupSize).length > 0) return [];

  const listingsById = new Map(listings.map((l) => [l.id, l]));
  const options = [];

  // a. Fewer nights: the largest count that unlocks anything.
  for (let n = nights - 1; n >= 1; n -= 1) {
    const found = filterListings(listings, members, n, groupSize);
    if (found.length > 0) {
      options.push({
        scope: 'group',
        change: { kind: 'nights', from: nights, to: n },
        unlockedListingIds: found.map((c) => c.listingId),
        cost: (nights - n) / nights,
      });
      break;
    }
  }

  for (const [i, m] of members.entries()) {
    const prefs = prefsOf(m);

    // b. Drop one preferred avoid. Strict (and legacy string) entries are never offered.
    for (const entry of prefs.avoidRoomTypes) {
      if (typeof entry === 'string' || entry.strength !== 'preferred') continue;
      const relaxed = members.map((x, j) => (j !== i ? x : {
        ...x,
        extracted: { ...prefs, avoidRoomTypes: prefs.avoidRoomTypes.filter((a) => a !== entry) },
      }));
      const found = filterListings(listings, relaxed, nights, groupSize);
      if (found.length > 0) {
        options.push(memberOption(relaxed, m.userId, { kind: 'allowRoomType', roomType: avoidType(entry) }, 0.25, found, listingsById));
      }
    }

    // c. Raise this member's cap. fairSplit is feasible iff sum(caps) >= total, so the
    // minimum raise for a listing is its shortfall; the cheapest eligible listing needs the least.
    const maxTotal = listings.reduce((mx, l) => Math.max(mx, l.price_per_night_cents * nights), 0);
    const unbounded = members.map((x, j) => (j !== i ? x : { ...x, capCents: x.capCents + maxTotal }));
    const eligible = filterListings(listings, unbounded, nights, groupSize);
    if (eligible.length === 0) continue;
    // Caps are per listing (consent overrides), so the shortfall is too.
    const shortfall = (c) => c.totalCents - capsForListing(members, c.listingId).reduce((s, x) => s + x.capCents, 0);
    const raise = roundUp(Math.min(...eligible.map(shortfall)));
    const raised = members.map((x, j) => (j !== i ? x : { ...x, capCents: x.capCents + raise }));
    const found = filterListings(listings, raised, nights, groupSize);
    if (found.length > 0) {
      options.push(memberOption(
        raised, m.userId, { kind: 'raiseBudget', byCents: raise },
        m.capCents > 0 ? raise / m.capCents : Infinity, found, listingsById,
        // The stay this raise was sized for (smallest shortfall, then cheapest): the override targets it.
        found.reduce((lo, c) => (shortfall(c) < shortfall(lo) ||
          (shortfall(c) === shortfall(lo) && c.totalCents < lo.totalCents) ? c : lo)),
      ));
    }
  }

  return options
    .sort((a, b) =>
      a.cost - b.cost ||
      b.unlockedListingIds.length - a.unlockedListingIds.length ||
      (a.userId ?? 0) - (b.userId ?? 0))
    .map(({ cost, ...rest }) => rest);
}
