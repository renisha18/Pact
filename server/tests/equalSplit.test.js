import { describe, it, expect } from 'vitest';
import { equalSplit } from '../src/lib/equalSplit.js';
import { splitFor } from '../src/lib/filterListings.js';

const members = (n) => Array.from({ length: n }, (_, i) => ({ userId: i + 1 }));
const amounts = (result) => result.shares.map((s) => s.amountCents);

describe('equalSplit', () => {
  it('splits evenly when the total divides', () => {
    expect(amounts(equalSplit(40000, members(4)))).toEqual([10000, 10000, 10000, 10000]);
  });

  it('gives leftover cents one each to the lowest userIds first', () => {
    expect(equalSplit(10000, members(3)).shares).toEqual([
      { userId: 1, amountCents: 3334 },
      { userId: 2, amountCents: 3333 },
      { userId: 3, amountCents: 3333 },
    ]);
    // input order doesn't matter: ids decide
    const shuffled = [{ userId: 9 }, { userId: 2 }, { userId: 5 }];
    expect(equalSplit(10, shuffled).shares).toEqual([
      { userId: 9, amountCents: 3 }, { userId: 2, amountCents: 4 }, { userId: 5, amountCents: 3 },
    ]);
  });

  it('always sums to the total', () => {
    for (let n = 1; n <= 9; n += 1) {
      for (const total of [0, 1, 7, 9999, 123457]) {
        const sum = equalSplit(total, members(n)).shares.reduce((s, x) => s + x.amountCents, 0);
        expect(sum).toBe(total);
      }
    }
  });

  it('rejects bad input', () => {
    expect(() => equalSplit(-1, members(2))).toThrow(TypeError);
    expect(() => equalSplit(10.5, members(2))).toThrow(TypeError);
    expect(() => equalSplit(10, [])).toThrow(TypeError);
    expect(() => equalSplit(10, [{ userId: 1 }, { userId: 1 }])).toThrow(TypeError);
  });
});

describe('splitFor (affordability)', () => {
  const m = (caps) => caps.map((capCents, i) => ({ userId: i + 1, capCents }));

  it('is feasible only when every share fits that member\'s budget', () => {
    expect(splitFor(40000, m([10000, 10000, 10000, 10000]), 1).feasible).toBe(true);
    // Total fits the combined budgets, but one member is below the equal share: not feasible.
    expect(splitFor(40000, m([7000, 20000, 20000, 20000]), 1).feasible).toBe(false);
  });

  it('every member pays the same amount (within one cent)', () => {
    const { shares } = splitFor(10001, m([99999, 99999, 99999]), 1);
    expect(Math.max(...amounts({ shares })) - Math.min(...amounts({ shares }))).toBeLessThanOrEqual(1);
  });

  it('uses an accepted override share for that listing only', () => {
    const base = m([5000, 20000]);
    base[0].overrides = [{ listingId: 7, kind: 'budget', maxShareCents: 9000, roomType: null }];
    expect(splitFor(18000, base, 7).feasible).toBe(true); // 9000 each, accepted
    expect(splitFor(18000, base, 8).feasible).toBe(false);
  });
});
