import { describe, it, expect } from 'vitest';
import { fairSplit } from '../src/lib/fairSplit.js';

const members = (caps) => caps.map((capCents, i) => ({ userId: i + 1, capCents }));
const amounts = (result) => result.shares.map((s) => s.amountCents);

describe('fairSplit', () => {
  it.each([
    ['equal caps', 40000, [20000, 20000, 20000, 20000], [10000, 10000, 10000, 10000]],
    ['one capped', 40000, [7000, 20000, 20000, 20000], [7000, 11000, 11000, 11000]],
    ['two capped', 40000, [7000, 8000, 30000, 30000], [7000, 8000, 12500, 12500]],
    ['cascading cap', 40000, [7000, 10500, 50000, 50000], [7000, 10500, 11250, 11250]],
  ])('%s', (_name, total, caps, expected) => {
    const result = fairSplit(total, members(caps));
    expect(result.feasible).toBe(true);
    expect(amounts(result)).toEqual(expected);
  });

  it('is infeasible when caps sum below total', () => {
    expect(fairSplit(40000, members([5000, 5000, 10000, 15000]))).toEqual({ feasible: false });
  });

  it('gives leftover cents to lowest userIds first', () => {
    const result = fairSplit(10000, members([10000, 10000, 10000]));
    expect(result.shares).toEqual([
      { userId: 1, amountCents: 3334 },
      { userId: 2, amountCents: 3333 },
      { userId: 3, amountCents: 3333 },
    ]);
  });

  it('leftover goes by userId, not input order', () => {
    const result = fairSplit(10000, [
      { userId: 3, capCents: 10000 },
      { userId: 1, capCents: 10000 },
      { userId: 2, capCents: 10000 },
    ]);
    expect(result.shares.find((s) => s.userId === 1).amountCents).toBe(3334);
  });

  it('caps exactly equal to total sum are feasible', () => {
    expect(amounts(fairSplit(30000, members([5000, 10000, 15000])))).toEqual([5000, 10000, 15000]);
  });

  it('rejects non-integer or negative cents', () => {
    expect(() => fairSplit(100.5, members([100]))).toThrow();
    expect(() => fairSplit(100, members([-1, 200]))).toThrow();
  });

  it('always sums to total and never exceeds caps (fuzz)', () => {
    for (let t = 0; t < 2000; t++) {
      const caps = Array.from({ length: 1 + Math.floor(Math.random() * 8) }, () => Math.floor(Math.random() * 50000));
      const total = Math.floor(Math.random() * 120000);
      const result = fairSplit(total, members(caps));
      const capSum = caps.reduce((a, b) => a + b, 0);
      expect(result.feasible).toBe(capSum >= total);
      if (result.feasible) {
        expect(amounts(result).reduce((a, b) => a + b, 0)).toBe(total);
        result.shares.forEach((s, i) => expect(s.amountCents).toBeLessThanOrEqual(caps[i]));
      }
    }
  });
});
