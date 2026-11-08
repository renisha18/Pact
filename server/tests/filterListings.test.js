import { describe, it, expect } from 'vitest';
import { filterListings } from '../src/lib/filterListings.js';

const listing = (id, over = {}) => ({
  id,
  price_per_night_cents: 10000,
  max_guests: 6,
  room_type: 'private_rooms',
  amenities: ['wifi'],
  vibe_tags: [],
  ...over,
});
const member = (userId, capCents, extracted = null) => ({ userId, capCents, extracted });
const prefs = (p) => ({ hardRequirements: [], avoidRoomTypes: [], softPreferences: [], ...p });
const ids = (cands) => cands.map((c) => c.listingId);

// 4 people, 5 nights, generous caps unless a test says otherwise.
const rich = [member(1, 100000), member(2, 100000), member(3, 100000), member(4, 100000)];

describe('filterListings', () => {
  it('excludes a listing missing any member’s hard requirement', () => {
    const members = [...rich.slice(0, 3), member(4, 100000, prefs({ hardRequirements: ['step-free access'] }))];
    const out = filterListings(
      [listing(1, { amenities: ['wifi', 'pool'] }), listing(2, { amenities: ['wifi', 'step-free access'] })],
      members, 5, 4,
    );
    expect(ids(out)).toEqual([2]);
  });

  it('hard requirements can be vibe tags too', () => {
    const members = [member(1, 100000, prefs({ hardRequirements: ['quiet'] }))];
    const out = filterListings([listing(1, { vibe_tags: ['party'] }), listing(2, { vibe_tags: ['quiet'] })], members, 2, 1);
    expect(ids(out)).toEqual([2]);
  });

  it('excludes a room type any member avoids', () => {
    const members = [...rich.slice(0, 3), member(4, 100000, prefs({ avoidRoomTypes: ['mixed_dorm'] }))];
    const out = filterListings(
      [listing(1, { room_type: 'mixed_dorm' }), listing(2, { room_type: 'shared_rooms' })],
      members, 5, 4,
    );
    expect(ids(out)).toEqual([2]);
  });

  it('excludes a listing the group cannot fairly afford', () => {
    // caps sum to 40000; listing 1 costs 5 x 10000 = 50000, listing 2 costs 5 x 8000 = 40000
    const members = [member(1, 5000), member(2, 5000), member(3, 15000), member(4, 15000)];
    const out = filterListings(
      [listing(1), listing(2, { price_per_night_cents: 8000 })],
      members, 5, 4,
    );
    expect(ids(out)).toEqual([2]);
    expect(out[0].totalCents).toBe(40000);
  });

  it('excludes listings too small for the group', () => {
    expect(ids(filterListings([listing(1, { max_guests: 3 }), listing(2)], rich, 5, 4))).toEqual([2]);
  });

  it('sorts by softMatchCount desc, then totalCents asc', () => {
    const members = [
      member(1, 100000, prefs({ softPreferences: ['pool', 'surf'] })),
      member(2, 100000, prefs({ softPreferences: ['pool'] })),
    ];
    const out = filterListings(
      [
        listing(1, { price_per_night_cents: 9000, amenities: [] }), // 0 matches
        listing(2, { price_per_night_cents: 12000, amenities: ['pool'] }), // 2 matches
        listing(3, { price_per_night_cents: 11000, amenities: ['pool'] }), // 2 matches, cheaper
        listing(4, { price_per_night_cents: 15000, amenities: ['pool'], vibe_tags: ['surf'] }), // 3 matches
        listing(5, { price_per_night_cents: 8000, amenities: [] }), // 0 matches, cheapest
      ],
      members, 3, 2,
    );
    expect(out.map((c) => [c.listingId, c.softMatchCount, c.totalCents])).toEqual([
      [4, 3, 45000],
      [3, 2, 33000],
      [2, 2, 36000],
      [5, 0, 24000],
      [1, 0, 27000],
    ]);
  });

  it('facts are neutral: no budgets, prices, names or member text', () => {
    const members = [
      { ...member(7, 61234, prefs({ softPreferences: ['pool'], hardRequirements: ['wifi'] })), name: 'Riya', preferences_text: 'SECRET' },
      member(8, 70000),
    ];
    const [c] = filterListings([listing(1, { amenities: ['wifi', 'pool'] })], members, 5, 2);
    expect(c.facts).toEqual([
      "fits everyone's budget",
      'has room for the whole group',
      "meets everyone's must-haves",
      "matches 1 of the group's wishes",
      'has private rooms',
      'has wifi',
      'has a pool',
    ]);
    const text = c.facts.join(' ');
    expect(text).not.toMatch(/\d{3,}|\$|Riya|SECRET|cap|cents/i);
  });

  it('treats members without extraction as having no constraints', () => {
    expect(ids(filterListings([listing(1)], rich, 1, 4))).toEqual([1]);
  });

  it('rejects bad arguments', () => {
    expect(() => filterListings([], rich, 0, 4)).toThrow();
    expect(() => filterListings([], [], 1, 1)).toThrow();
  });
});
