import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { filterListings } from '../src/lib/filterListings.js';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});
vi.mock('../src/ai/llm.js', () => {
  class AiError extends Error {}
  const generateJson = vi.fn(async (system, content) => {
    if (system.includes('extract trip-stay preferences')) {
      return { features: [], avoidRoomTypes: [] };
    }
    const ids = [...content.matchAll(/"listingId":(\d+)/g)].map((m) => Number(m[1]));
    return { picks: ids.map((listingId) => ({ listingId, reason: 'Lovely spot.' })) };
  });
  return { generateJson, generateText: vi.fn(async () => 'Small idea.'), AiError, aiMode: () => 'live' };
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');

// --- pure filter

const L = (id, cents, room = 'private_rooms') => ({ id, price_per_night_cents: cents, max_guests: 4, room_type: room, amenities: [], vibe_tags: [] });
const prefs = (avoid) => ({ hardRequirements: [], avoidRoomTypes: avoid, softPreferences: [] });

describe('filterListings: overrides apply only to their own listing', () => {
  it('a budget override unlocks its listing and no other', () => {
    const members = [
      { userId: 1, capCents: 5000, overrides: [{ listingId: 1, kind: 'budget', maxShareCents: 6800, roomType: null }] },
      { userId: 2, capCents: 5000 },
    ];
    // Without the override neither fits; with a global +$20 both would.
    expect(filterListings([L(1, 11800), L(2, 12000)], members, 1, 2).map((c) => c.listingId)).toEqual([1]);
  });

  it('a room-type override lifts a preferred avoid at its listing only, never a strict one', () => {
    const members = [
      { userId: 1, capCents: 9000, extracted: prefs([{ type: 'shared_rooms', strength: 'preferred' }, { type: 'mixed_dorm', strength: 'strict' }]),
        overrides: [
          { listingId: 1, kind: 'room_type', maxShareCents: 3000, roomType: 'shared_rooms' },
          { listingId: 3, kind: 'room_type', maxShareCents: 3000, roomType: 'mixed_dorm' },
        ] },
      { userId: 2, capCents: 9000 },
    ];
    const out = filterListings([L(1, 6000, 'shared_rooms'), L(2, 6000, 'shared_rooms'), L(3, 6000, 'mixed_dorm')], members, 1, 2);
    expect(out.map((c) => c.listingId)).toEqual([1]);
  });

  it('a room-type override also caps that member at the accepted share for that listing', () => {
    const members = [
      { userId: 1, capCents: 9000, extracted: prefs([{ type: 'shared_rooms', strength: 'preferred' }]),
        overrides: [{ listingId: 1, kind: 'room_type', maxShareCents: 1000, roomType: 'shared_rooms' }] },
      { userId: 2, capCents: 4000 },
    ];
    expect(filterListings([L(1, 6000, 'shared_rooms')], members, 1, 2)).toEqual([]); // 1000 + 4000 < 6000
  });
});

// --- routes

const as = (u) => `pact_session=${jwt.sign({ sub: String(u) }, process.env.JWT_SECRET)}`;
const A = 1;
const B = 2;
const plan = (trip) => request(app).post(`/api/trips/${trip}/plan`).set('Cookie', as(A));
const myAsk = (trip, u) => request(app).get(`/api/trips/${trip}/my-negotiation`).set('Cookie', as(u));
const respond = (trip, nid, u, response) =>
  request(app).post(`/api/trips/${trip}/negotiations/${nid}`).set('Cookie', as(u)).send({ response });
const vote = (trip, u, proposalId) =>
  request(app).post(`/api/trips/${trip}/votes`).set('Cookie', as(u)).send({ proposalId });
const overrides = async (trip) => (await pg.query(
  'SELECT user_id, listing_id, kind, accepted_max_share_cents, status FROM consent_overrides WHERE trip_id = $1 ORDER BY id', [trip],
)).rows;

beforeAll(async () => {
  // Caps $50 + $50. Villa X $118 (shortfall $18 -> ask $20, A's share $68). Villa Y $120:
  // a plain +$20 budget raise WOULD make Y affordable; a listing-scoped override must not.
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Riya', 'r@pact.demo'), ('Arjun', 'a@pact.demo');
    INSERT INTO groups (name, invite_token, personality) VALUES ('G', 'tok', 'chill');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1, 1, 'organizer'), (1, 2, 'member');
    INSERT INTO trips (group_id, title, start_date, end_date, nights) VALUES
      (1, 'T1', '2027-01-01', '2027-01-02', 1), (1, 'T2', '2027-02-01', '2027-02-02', 1),
      (1, 'T3', '2027-03-01', '2027-03-02', 1);
    INSERT INTO trip_members (trip_id, user_id) SELECT t, u FROM generate_series(1, 3) t, generate_series(1, 2) u;
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type) VALUES
      ('Villa X', 'Ubud', 11800, 4, 'private_rooms'), ('Villa Y', 'Ubud', 12000, 4, 'private_rooms');
  `);
  for (const trip of [1, 2, 3]) {
    for (const u of [A, B]) {
      const r = await request(app).put(`/api/trips/${trip}/private-input`).set('Cookie', as(u))
        .send({ maxBudgetUsd: 50, preferencesText: 'anything', comfortText: '', commitmentType: 'hold' });
      expect(r.status).toBe(200);
    }
  }
});

/** No-fit plan -> A is asked for a raise -> A accepts. Returns the accept response. */
async function acceptRaise(trip) {
  expect((await plan(trip)).body.proposals).toEqual([]);
  const ask = (await myAsk(trip, A)).body;
  expect(ask).toMatchObject({ kind: 'raiseBudget', raiseByCents: 2000, newShareCents: 6800, stay: { name: 'Villa X' } });
  return respond(trip, ask.id, A, 'accept');
}

describe('consent overrides', () => {
  it('a raise cannot make a different stay affordable', async () => {
    const res = await acceptRaise(1);
    expect(res.status).toBe(200);
    expect(res.body.plan.proposals.map((p) => p.listingName)).toEqual(['Villa X']); // not Villa Y
    const { rows: [pi] } = await pg.query('SELECT max_budget_cents FROM private_inputs WHERE trip_id = 1 AND user_id = $1', [A]);
    expect(pi.max_budget_cents).toBe(5000); // private input untouched
    expect(await overrides(1)).toEqual([{ user_id: A, listing_id: 1, kind: 'budget', accepted_max_share_cents: 6800, status: 'active' }]);
  });

  it('a member is never charged above the accepted share; other stays\' consent expires', async () => {
    // A stray override for Villa Y must expire once Villa X wins.
    const { rows: [n] } = await pg.query('SELECT id FROM negotiations WHERE trip_id = 1 LIMIT 1');
    await pg.query(
      `INSERT INTO consent_overrides (trip_id, user_id, negotiation_id, plan_version, listing_id, kind, accepted_max_share_cents)
       VALUES (1, 2, $1, 0, 2, 'budget', 7000)`, [n.id],
    );
    const { proposals } = (await request(app).get('/api/trips/1/proposals').set('Cookie', as(B))).body;
    await vote(1, A, proposals[0].id);
    const res = await vote(1, B, proposals[0].id);
    expect(res.body.status).toBe('committing');
    const { rows: shares } = await pg.query('SELECT user_id, amount_cents FROM shares WHERE trip_id = 1 ORDER BY user_id');
    expect(shares).toEqual([{ user_id: A, amount_cents: 6800 }, { user_id: B, amount_cents: 5000 }]);
    expect((await overrides(1)).map((o) => [o.listing_id, o.status])).toEqual([[1, 'active'], [2, 'expired']]);
  });

  it('a changed split that would exceed the accepted share -> no shares, re-check, fresh consent needed', async () => {
    expect((await acceptRaise(2)).status).toBe(200);
    // B's budget drops after A consented: X would now need more than A's accepted $68.
    await pg.query('UPDATE private_inputs SET max_budget_cents = 4000 WHERE trip_id = 2 AND user_id = $1', [B]);
    const { proposals } = (await request(app).get('/api/trips/2/proposals').set('Cookie', as(B))).body;
    await vote(2, A, proposals[0].id);
    const res = await vote(2, B, proposals[0].id);
    expect(res.body).toEqual({ status: 'planning', message: 'Plans need a quick re-check' });
    expect((await pg.query('SELECT 1 FROM shares WHERE trip_id = 2')).rows).toEqual([]);
    const { rows: [t] } = await pg.query('SELECT status, chosen_listing_id FROM trips WHERE id = 2');
    expect(t).toEqual({ status: 'planning', chosen_listing_id: null });
    expect((await overrides(2)).map((o) => o.status)).toEqual(['expired']);
    // Message is public and generic: no names, no amounts.
    expect(JSON.stringify(res.body)).not.toMatch(/Riya|Arjun|68|\$/);
  });

  it('editing private input expires that member\'s overrides', async () => {
    expect((await acceptRaise(3)).status).toBe(200);
    await pg.query(`UPDATE trips SET status = 'planning' WHERE id = 3`); // inputs are editable while planning
    const r = await request(app).put('/api/trips/3/private-input').set('Cookie', as(A))
      .send({ maxBudgetUsd: 50, preferencesText: 'anything', comfortText: '', commitmentType: 'hold' });
    expect(r.status).toBe(200);
    expect((await overrides(3)).map((o) => o.status)).toEqual(['expired']);
    // Without the consent, Villa X no longer fits: Pact asks again rather than reusing it.
    const replan = await plan(3);
    expect(replan.body.proposals).toEqual([]);
    expect((await myAsk(3, A)).body.kind).toBe('raiseBudget');
  });

  it('leaving and cancelling expire overrides', async () => {
    await pg.query(`UPDATE consent_overrides SET status = 'active' WHERE trip_id = 3`);
    const cancel = await request(app).post('/api/trips/3/cancel').set('Cookie', as(A));
    expect(cancel.status).toBe(200);
    expect((await overrides(3)).every((o) => o.status === 'expired')).toBe(true);

    await pg.query(`UPDATE consent_overrides SET status = 'active' WHERE trip_id = 1`);
    const leave = await request(app).post('/api/trips/1/leave').set('Cookie', as(A));
    expect(leave.status).toBe(200);
    expect((await overrides(1)).filter((o) => o.user_id === A).map((o) => o.status)).toEqual(['expired']);
    expect((await overrides(1)).filter((o) => o.user_id === B).map((o) => o.status)).toEqual(['active']);
  });
});
