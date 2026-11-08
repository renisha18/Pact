import { describe, it, expect } from 'vitest';
import { leakCheck } from '../src/lib/leakCheck.js';

const inputs = [
  {
    name: 'Priya',
    max_budget_cents: 15000,
    preferences_text: 'I really want a quiet place near the beach, no loud parties.',
    comfort_text: 'Happy to share a room with Sam.',
  },
  {
    name: 'Sam Lee',
    max_budget_cents: 32050,
    preferences_text: 'Pool is a must!',
    comfort_text: '',
  },
];

describe('leakCheck', () => {
  it.each([
    'This one costs $150 per person.',
    'Stay under 150 dollars each.',
    'Roughly 150.00 a head.',
    'That is 15000 cents.',
    'Sam can do up to $320.50.',
  ])('catches budget number: %s', (text) => {
    expect(leakCheck(text, inputs)).toEqual({ safe: false, reason: 'budget_number' });
  });

  it('catches a copied 4-word phrase (case and punctuation ignored)', () => {
    const r = leakCheck('Great pick -- A QUIET, place near the water!', inputs);
    expect(r).toEqual({ safe: false, reason: 'private_phrase' });
  });

  it('catches a name next to "budget of"', () => {
    expect(leakCheck("Priya's budget of the group is the tightest.", inputs).reason).toBe('name_budget');
    expect(leakCheck('We kept within the budget of Sam Lee.', inputs).reason).toBe('name_budget');
  });

  it('allows a normal sentence', () => {
    expect(leakCheck('This villa fits everyone and has a pool.', inputs)).toEqual({ safe: true, reason: null });
  });

  it('allows 3-word overlaps and unrelated numbers', () => {
    expect(leakCheck('A quiet place with 4 bedrooms for $210.', inputs).safe).toBe(true);
  });
});
