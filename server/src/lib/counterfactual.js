// Pure "what would unlock a stay?" search: no AI, no DB. All amounts are integer cents.
// Runs only when filterListings finds nothing, and tries ONE change at a time:
//   a. group:  fewer nights
//   b. member: drop one 'preferred' avoided room type
//   c. members: raise their budget to the listing's equal share, for a listing that fails
//      ONLY on budget and needs at most 2 members to raise. Each is asked for exactly their own amount.
// It never touches 'strict' avoids or hard requirements (both come from comfort_text).
// Member-scoped options carry private numbers: route each one ONLY to its userId.
import { filterListings, avoidType, splitFor, capForListing } from './filterListings.js';

export const MAX_BUDGET_RAISERS = 2;

const EMPTY = { hardRequirements: [], avoidRoomTypes: [], softPreferences: [] };
const prefsOf = (m) => ({ ...EMPTY, ...(m.extracted ?? {}) });

function shareFor(totalCents, members, userId, listingId) {
  return splitFor(totalCents, members, listingId).shares.find((s) => s.userId === userId).amountCents;
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
  }

  // c. Budget: stays that fail only on budget (everything else passes when budgets are unlimited).
  // Each member below the equal share would need (equalShare - budget). One stay's raisers are asked
  // together, each for exactly their own amount; their accepted share is that stay's equal share.
  const unlimited = members.map((x) => ({ ...x, capCents: Number.MAX_SAFE_INTEGER }));
  const units = [];
  for (const c of filterListings(listings, unlimited, nights, groupSize)) {
    const { shares } = splitFor(c.totalCents, members, c.listingId);
    const raisers = shares
      .map((sh) => ({ sh, cap: capForListing(members.find((m) => m.userId === sh.userId), c.listingId) }))
      .filter(({ sh, cap }) => sh.amountCents > cap);
    if (raisers.length >= 1 && raisers.length <= MAX_BUDGET_RAISERS) units.push({ c, raisers });
  }
  units.sort((a, b) =>
    a.raisers.length - b.raisers.length ||
    a.raisers.reduce((t, r) => t + r.sh.amountCents - r.cap, 0) - b.raisers.reduce((t, r) => t + r.sh.amountCents - r.cap, 0) ||
    a.c.totalCents - b.c.totalCents || a.c.listingId - b.c.listingId);
  const best = units[0];
  if (best) {
    const listing = listingsById.get(best.c.listingId);
    const features = new Set([...(listing.amenities ?? []), ...(listing.vibe_tags ?? [])]);
    for (const { sh, cap } of best.raisers) {
      const own = prefsOf(members.find((m) => m.userId === sh.userId));
      options.push({
        scope: 'member',
        userId: sh.userId,
        change: { kind: 'raiseBudget', byCents: sh.amountCents - cap },
        unlockedListingIds: [best.c.listingId],
        listingId: best.c.listingId,
        newShareCents: sh.amountCents,
        matchesOwnWishes: own.softPreferences.filter((w) => features.has(w)),
        unit: `budget:${best.c.listingId}`, // every raiser of this stay must accept
        cost: cap > 0 ? (sh.amountCents - cap) / cap : Infinity,
      });
    }
  }

  return options
    .sort((a, b) =>
      a.cost - b.cost ||
      b.unlockedListingIds.length - a.unlockedListingIds.length ||
      (a.userId ?? 0) - (b.userId ?? 0))
    .map(({ cost, ...rest }) => rest);
}
