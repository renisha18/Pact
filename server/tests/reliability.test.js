import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateJson = vi.fn();
const generateText = vi.fn();
vi.mock('../src/ai/llm.js', () => {
  class AiError extends Error {}
  return { generateJson, generateText, AiError, aiMode: () => 'live' };
});

const { pickAndExplain, topProposals, templateReason } = await import('../src/ai/plan.js');
const { writeNegotiationMessage, templateMessage, dollarAmounts } = await import('../src/ai/negotiate.js');

const cand = (listingId, softMatchCount, totalCents) => ({ listingId, softMatchCount, totalCents, facts: ['fits'] });
const listing = (id) => ({ id, name: `Stay ${id}`, area: 'Ubud', room_type: 'private_rooms', amenities: [], vibe_tags: [] });
const listingsById = new Map([1, 2, 3, 4, 5].map((id) => [id, listing(id)]));
const privateInputs = [{ user_id: 9, name: 'Riya', max_budget_cents: 13700, preferences_text: 'quiet', comfort_text: '' }];

beforeEach(() => {
  generateJson.mockReset();
  generateText.mockReset();
});

describe('deterministic top 3 proposals', () => {
  // Unsorted input; expected order: soft desc, total asc, id asc -> 4, 2, 5 (then 1, 3).
  const candidates = [cand(1, 0, 100), cand(2, 2, 300), cand(3, 0, 50), cand(4, 2, 200), cand(5, 2, 300)];

  it('ranks by softMatchCount desc, totalCents asc, listingId asc', () => {
    expect(topProposals(candidates).map((c) => c.listingId)).toEqual([4, 2, 5]);
  });

  it('the AI cannot choose stays: invented and lower-ranked ids are ignored', async () => {
    generateJson.mockResolvedValue({ picks: [
      { listingId: 3, reason: 'AI wants this one.' },
      { listingId: 99, reason: 'Made up.' },
      { listingId: 2, reason: 'Two is breezy.' },
    ] });
    const out = await pickAndExplain(candidates, listingsById, 'chill', privateInputs);
    expect(out.map((p) => p.listingId)).toEqual([4, 2, 5]);
    expect(out[1].reason).toBe('Two is breezy.');
    // Only the 3 chosen stays were sent to the AI.
    const ids = [...generateJson.mock.calls[0][1].matchAll(/"listingId":(\d+)/g)].map((m) => Number(m[1]));
    expect(ids).toEqual([4, 2, 5]);
  });

  it('missing reasons use the template; unsafe ones regenerate once, then template', async () => {
    generateJson
      .mockResolvedValueOnce({ picks: [{ listingId: 2, reason: 'Fits a $137 budget.' }] })
      .mockResolvedValueOnce({ reason: 'Riya would love the $137 price.' });
    const out = await pickAndExplain(candidates, listingsById, 'chill', privateInputs);
    expect(out).toEqual([
      { listingId: 4, reason: templateReason(candidates[3], listing(4), privateInputs) },
      { listingId: 2, reason: templateReason(candidates[1], listing(2), privateInputs) },
      { listingId: 5, reason: templateReason(candidates[4], listing(5), privateInputs) },
    ]);
    expect(generateJson).toHaveBeenCalledTimes(2); // one batch + one regeneration (only for 2)
  });

  it('AI failure still returns the same top 3 with templates', async () => {
    generateJson.mockRejectedValue(new Error('down'));
    const out = await pickAndExplain(candidates, listingsById, 'chill', privateInputs);
    expect(out.map((p) => p.listingId)).toEqual([4, 2, 5]);
    expect(out.every((p) => p.reason.startsWith('Stay'))).toBe(true);
  });
});

describe('negotiation message dollar amounts', () => {
  const option = {
    change: { kind: 'raiseBudget', byCents: 5500 }, listingId: 1, newShareCents: 12746, matchesOwnWishes: [],
  };
  const stay = { name: 'Stay 1', area: 'Ubud' };
  const write = () => writeNegotiationMessage({ personality: 'chill', ownItems: {}, option, stay, otherPrivateInputs: [] });

  it('extracts $, USD and "dollars" amounts in cents', () => {
    expect(dollarAmounts('Add $55, pay $127.46, or USD 1,000 or 20 dollars')).toEqual([5500, 12746, 100000, 2000]);
  });

  it('keeps AI text whose amounts are exactly the server-provided ones', async () => {
    generateText.mockResolvedValue('Stretch by $55.00 and your share is $127.46.');
    expect(await write()).toMatch(/^Stretch by \$55\.00 and your share is \$127\.46\./);
  });

  for (const bad of ['Stretch by $60 and you are set.', 'Your share would be $127.', 'Just 50 dollars more!', 'Add USD 5 and go.']) {
    it(`uses the template when the AI states another amount: "${bad}"`, async () => {
      generateText.mockResolvedValue(bad);
      expect(await write()).toBe(`${templateMessage(option, stay, [])} Saying no is completely fine, and if you need more time, that's okay too.`);
    });
  }

  it('non-budget asks may only state the share', async () => {
    const allow = { change: { kind: 'allowRoomType', roomType: 'shared_rooms' }, listingId: 1, newShareCents: 2000, matchesOwnWishes: [] };
    generateText.mockResolvedValue('Shared rooms would bring your share to $20 and save $40.');
    const msg = await writeNegotiationMessage({ personality: 'chill', ownItems: {}, option: allow, stay, otherPrivateInputs: [] });
    expect(msg).toBe(`${templateMessage(allow, stay, [])} Saying no is completely fine.`);
  });
});
