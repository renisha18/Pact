import { describe, it, expect } from 'vitest';
import { counterfactual } from '../src/lib/counterfactual.js';

const listing = (id, over = {}) => ({
  id, price_per_night_cents: 10000, max_guests: 6, room_type: 'private_rooms', amenities: [], vibe_tags: [], ...over,
});
const member = (userId, capCents, extracted = null) => ({ userId, capCents, extracted });
const prefs = (p) => ({ hardRequirements: [], avoidRoomTypes: [], softPreferences: [], ...p });
const strict = (type) => ({ type, strength: 'strict' });
const preferred = (type) => ({ type, strength: 'preferred' });

describe('counterfactual', () => {
  it('returns [] when there are already candidates', () => {
    expect(counterfactual([listing(1)], [member(1, 100000)], 2, 1)).toEqual([]);
  });

  it('never proposes dropping a strict avoid', () => {
    const members = [
      member(1, 100000, prefs({ avoidRoomTypes: [strict('mixed_dorm')] })),
      member(2, 100000, prefs({ avoidRoomTypes: ['mixed_dorm'] })), // legacy string = strict
    ];
    const out = counterfactual([listing(1, { room_type: 'mixed_dorm', price_per_night_cents: 1000 })], members, 2, 2);
    expect(out).toEqual([]);
  });

  it('proposes dropping a preferred avoid, with share and own wishes', () => {
    const members = [
      member(1, 100000, prefs({ avoidRoomTypes: [strict('mixed_dorm'), preferred('shared_rooms')], softPreferences: ['pool', 'quiet'] })),
      member(2, 100000),
    ];
    const out = counterfactual(
      [listing(1, { room_type: 'mixed_dorm' }), listing(7, { room_type: 'shared_rooms', amenities: ['pool'] })],
      members, 2, 2,
    );
    expect(out).toEqual([{
      scope: 'member', userId: 1,
      change: { kind: 'allowRoomType', roomType: 'shared_rooms' },
      unlockedListingIds: [7], listingId: 7, newShareCents: 10000, matchesOwnWishes: ['pool'],
    }]);
    expect(JSON.stringify(out)).not.toContain('mixed_dorm');
  });

  it('budget ask is the minimum needed, rounded up to $5', () => {
    // 2 nights x $101.23 = $202.46; caps sum $150 -> shortfall $52.46 -> ask $55.
    const members = [member(1, 7500), member(2, 7500)];
    const out = counterfactual(
      [listing(1, { price_per_night_cents: 10123 }), listing(2, { price_per_night_cents: 20000 })],
      members, 2, 2,
    ).filter((o) => o.change.kind === 'raiseBudget');
    // Raised member pays 20246 - 7500 = 12746.
    expect(out.map((o) => [o.userId, o.change.byCents, o.newShareCents, o.unlockedListingIds])).toEqual([
      [1, 5500, 12746, [1]],
      [2, 5500, 12746, [1]],
    ]);
    // $5 less ($50) still leaves a shortfall, which itself rounds up to exactly $5.
    const after50 = counterfactual([listing(1, { price_per_night_cents: 10123 })], [member(1, 12500), member(2, 7500)], 2, 2);
    expect(after50.filter((o) => o.change.kind === 'raiseBudget').map((o) => o.change.byCents)).toEqual([500, 500]);
  });

  it('nights option is the largest count that unlocks a listing', () => {
    // Caps $300 total; $100/night -> 3 nights fits, 4+ does not.
    const members = [member(1, 15000), member(2, 15000)];
    const out = counterfactual([listing(1)], members, 6, 2);
    expect(out.find((o) => o.scope === 'group')).toEqual({
      scope: 'group', change: { kind: 'nights', from: 6, to: 3 }, unlockedListingIds: [1],
    });
  });

  it('options are sorted smallest change first', () => {
    // 5 nights x $100 = $500 vs caps $480: 1 night less (20%) vs a $20 raise (~8% of $240).
    const members = [
      member(1, 24000, prefs({ avoidRoomTypes: [preferred('shared_rooms')] })),
      member(2, 24000),
    ];
    const out = counterfactual(
      [listing(1), listing(2, { room_type: 'shared_rooms', price_per_night_cents: 9000 })],
      members, 5, 2,
    );
    expect(out.map((o) => o.change.kind)).toEqual(['raiseBudget', 'raiseBudget', 'nights', 'allowRoomType']);
    expect(out[0].change.byCents).toBe(2000);
  });
});
