import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});

// Extraction keys off markers in member text: COMFORT-DORM -> strict mixed_dorm,
// PREF-SHARED -> preferred shared_rooms.
const generateJson = vi.fn(async (system, content) => {
  if (system.includes('extract trip-stay preferences')) {
    return {
      hardRequirements: [],
      avoidRoomTypes: content.includes('COMFORT-DORM') ? ['mixed_dorm'] : [],
      preferredAvoidRoomTypes: content.includes('PREF-SHARED') ? ['shared_rooms'] : [],
      softPreferences: ['wifi'],
    };
  }
  const ids = [...content.matchAll(/"listingId":(\d+)/g)].map((m) => Number(m[1]));
  return { picks: [...new Set(ids)].slice(0, 3).map((listingId) => ({ listingId, reason: 'Lovely spot.' })) };
});
// The writer tries to leak Meera's $70 budget; leakCheck must swap in the template.
const generateText = vi.fn(async () => 'Meera only has $70, so it is on you!');
vi.mock('../src/ai/llm.js', () => {
  class AiError extends Error {}
  return { generateJson, generateText, AiError, aiMode: () => 'live' };
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');

const as = (userId) => `pact_session=${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}`;
const A = 1; // Riya, organizer, $100, strict: no dorms
const B = 2; // Arjun, $80, would rather avoid shared rooms
const C = 3; // Meera, $70
const WORKING = 'Pact is working something out privately…';
const EXHAUSTED = "Pact couldn't find a plan that fits everyone — try changing the trip.";

const TEXT = {
  [A]: ['SECRET-A loves quiet mornings', 'COMFORT-DORM SECRET-A never sleeps in dorms'],
  [B]: ['PREF-SHARED SECRET-B prefers own room', 'SECRET-B fine otherwise'],
  [C]: ['SECRET-C likes the beach a lot', 'SECRET-C nothing else'],
};
const USD = { [A]: 100, [B]: 80, [C]: 70 };
const NAMES = { [A]: 'Riya', [B]: 'Arjun', [C]: 'Meera' };
const others = (me) => [A, B, C].filter((u) => u !== me);
const forbiddenFor = (me) => others(me).flatMap((u) => [NAMES[u], `SECRET-${'ABC'[u - 1]}`, String(USD[u])]);

beforeAll(async () => {
  // 1 night, 3 guests. Dorm: strict-avoided by A. Shared: preferred-avoided by B.
  // Villa: $300 vs caps $250. Nothing fits; fewer nights is impossible.
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Riya', 'r@pact.demo'), ('Arjun', 'a@pact.demo'), ('Meera', 'm@pact.demo');
    INSERT INTO groups (name, invite_token, personality) VALUES ('G', 'tok', 'wholesome');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1, 1, 'organizer'), (1, 2, 'member'), (1, 3, 'member');
    INSERT INTO trips (group_id, title, start_date, end_date, nights) VALUES
      (1, 'T1', '2027-01-01', '2027-01-02', 1), (1, 'T2', '2027-02-01', '2027-02-02', 1),
      (1, 'T3', '2027-03-01', '2027-03-03', 2), (1, 'T4', '2027-04-01', '2027-04-02', 1),
      (1, 'T5', '2027-05-01', '2027-05-02', 1);
    INSERT INTO trip_members (trip_id, user_id) VALUES
      (1, 1), (1, 2), (1, 3), (2, 1), (2, 2), (2, 3), (3, 1), (3, 2), (3, 3),
      (4, 1), (4, 2), (4, 3), (5, 1), (5, 2), (5, 3);
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type, amenities) VALUES
      ('Dorm Den', 'Kuta', 3000, 6, 'mixed_dorm', '{wifi}'),
      ('Shared Nest', 'Canggu', 6000, 6, 'shared_rooms', '{wifi}'),
      ('Private Villa', 'Ubud', 30000, 6, 'private_rooms', '{pool}');
  `);
  for (const trip of [1, 2, 3, 4, 5]) {
    for (const u of [A, B, C]) {
      const res = await request(app).put(`/api/trips/${trip}/private-input`).set('Cookie', as(u)).send({
        maxBudgetUsd: USD[u], preferencesText: TEXT[u][0], comfortText: TEXT[u][1], commitmentType: 'hold',
      });
      expect(res.status).toBe(200);
    }
  }
});

const get = (trip, u) => request(app).get(`/api/trips/${trip}/my-negotiation`).set('Cookie', as(u));
const respond = (trip, nid, u, response) =>
  request(app).post(`/api/trips/${trip}/negotiations/${nid}`).set('Cookie', as(u)).send({ response });

describe('negotiations', () => {
  let negB;

  it('no fit -> group sees only a generic notice', async () => {
    const plan = await request(app).post('/api/trips/1/plan').set('Cookie', as(A));
    expect(plan.status).toBe(200);
    expect(plan.body).toEqual({ status: 'collecting', proposals: [], message: WORKING });

    const props = await request(app).get('/api/trips/1/proposals').set('Cookie', as(C));
    expect(props.body.notice).toBe(WORKING);
    for (const f of ['Riya', 'Arjun', 'Meera', 'SECRET', '"2"', 'shared']) expect(JSON.stringify(props.body)).not.toContain(f);
  });

  it('asks at most 2 members, smallest change first; strict items are never negotiated', async () => {
    const { rows } = await pg.query(`SELECT user_id, change_json FROM negotiations WHERE trip_id = 1 ORDER BY user_id`);
    expect(rows.map((r) => [r.user_id, r.change_json.change.kind])).toEqual([[A, 'raiseBudget'], [B, 'allowRoomType']]);
    expect(JSON.stringify(rows)).not.toContain('mixed_dorm');

    const b = await get(1, B);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({
      kind: 'allowRoomType', roomType: 'shared_rooms', stay: { name: 'Shared Nest' },
      newShareCents: 2000, matchesOwnWishes: ['wifi'], responses: ['accept', 'reject', 'another'],
    });
    negB = b.body.id;

    const a = await get(1, A);
    expect(a.body).toMatchObject({ kind: 'raiseBudget', raiseByCents: 5000, newShareCents: 15000 });
    expect(a.body.responses).toContain('more_time');
    expect(a.body.message).toMatch(/if you need more time/);

    expect((await get(1, C)).status).toBe(404);
  });

  it('message contains no other member\'s data and says no is fine', async () => {
    for (const u of [A, B]) {
      const { body } = await get(1, u);
      expect(body.message).toContain('Saying no is completely fine');
      for (const f of forbiddenFor(u)) expect(body.message).not.toContain(f);
    }
    // The writer itself only ever saw the member's own items.
    for (const [, content] of generateText.mock.calls) {
      expect(content).not.toMatch(/SECRET|Riya|Arjun|Meera/);
    }
  });

  it('other members get 404 on someone else\'s negotiation', async () => {
    for (const u of [A, C]) {
      expect((await respond(1, negB, u, 'accept')).status).toBe(404);
      expect((await respond(1, negB, u, 'reject')).status).toBe(404);
    }
    expect((await respond(1, 99999, B, 'accept')).status).toBe(404);
    expect((await get(1, B)).body.id).toBe(negB); // untouched
  });

  it('accept applies the change to the member\'s own input and re-plans', async () => {
    const res = await respond(1, negB, B, 'accept');
    expect(res.status).toBe(200);
    expect(res.body.plan.status).toBe('voting');
    expect(res.body.plan.proposals.map((p) => p.listingName)).toContain('Shared Nest');

    const { rows: [pi] } = await pg.query('SELECT allowed_room_types FROM private_inputs WHERE trip_id = 1 AND user_id = $1', [B]);
    expect(pi.allowed_room_types).toEqual(['shared_rooms']);
    expect((await get(1, A)).status).toBe(404); // A's ask is moot now
    const props = await request(app).get('/api/trips/1/proposals').set('Cookie', as(C));
    expect(props.body.notice).toBeNull();
  });

  it('another gives one alternative; rejecting everything shows the public fallback', async () => {
    await request(app).post('/api/trips/2/plan').set('Cookie', as(A));
    // A (the one budget ask) declines first, so B's budget alternative is allowed.
    const a = await get(2, A);
    expect((await respond(2, a.body.id, A, 'reject')).body.notice).toBeUndefined();
    const first = await get(2, B);
    const alt = await respond(2, first.body.id, B, 'another');
    expect(alt.body.negotiation).toMatchObject({ kind: 'raiseBudget' });
    expect(alt.body.negotiation.responses).not.toContain('another');

    expect((await respond(2, alt.body.negotiation.id, B, 'reject')).body.notice).toBe(EXHAUSTED);

    const props = await request(app).get('/api/trips/2/proposals').set('Cookie', as(C));
    expect(props.body.notice).toBe(EXHAUSTED);

    // Re-planning never re-asks what was declined; it moves on to whoever wasn't asked.
    const replan = await request(app).post('/api/trips/2/plan').set('Cookie', as(A));
    expect(replan.body.message).toBe(WORKING);
    expect((await get(2, A)).status).toBe(404);
    expect((await get(2, B)).status).toBe(404);
    expect((await get(2, C)).body.kind).toBe('raiseBudget');
  });

  it('editing private input expires only that member\'s pending ask', async () => {
    await request(app).post('/api/trips/4/plan').set('Cookie', as(A));
    const a = await get(4, A);
    const b = await get(4, B);
    expect(a.body.kind).toBe('raiseBudget');

    const put = await request(app).put('/api/trips/4/private-input').set('Cookie', as(A)).send({
      maxBudgetUsd: 90, preferencesText: TEXT[A][0], comfortText: TEXT[A][1], commitmentType: 'hold',
    });
    expect(put.status).toBe(200);
    expect((await get(4, A)).status).toBe(404);
    expect((await respond(4, a.body.id, A, 'accept')).status).toBe(409); // stale ask can't be accepted
    const { rows: [pi] } = await pg.query('SELECT max_budget_cents FROM private_inputs WHERE trip_id = 4 AND user_id = $1', [A]);
    expect(pi.max_budget_cents).toBe(9000); // not 9000 + the stale raise
    expect((await get(4, B)).body.id).toBe(b.body.id); // B untouched
  });

  it('a budget alternative is not offered while another member\'s budget ask is open', async () => {
    await request(app).post('/api/trips/5/plan').set('Cookie', as(A));
    expect((await get(5, A)).body.kind).toBe('raiseBudget');
    const b = await get(5, B);
    const res = await respond(5, b.body.id, B, 'another');
    expect(res.body.response).toBe('reject');
    expect(res.body.negotiation).toBeUndefined();
    const { rows } = await pg.query(
      `SELECT user_id FROM negotiations WHERE trip_id = 5 AND status = 'pending' AND change_json->'change'->>'kind' = 'raiseBudget'`,
    );
    expect(rows.map((r) => r.user_id)).toEqual([A]);
  });

  it('openNegotiations asks at most one member for money per shortfall', async () => {
    const { openNegotiations } = await import('../src/lib/negotiations.js');
    const raise = (userId) => ({ scope: 'member', userId, change: { kind: 'raiseBudget', byCents: 5000 },
      unlockedListingIds: [3], listingId: 3, newShareCents: 15000, matchesOwnWishes: [] });
    const allow = (userId) => ({ scope: 'member', userId, change: { kind: 'allowRoomType', roomType: 'private_rooms' },
      unlockedListingIds: [2], listingId: 2, newShareCents: 2000, matchesOwnWishes: [] });
    const { rows: listings } = await pg.query('SELECT id, name, area FROM listings');
    const ctx = { personality: 'chill', extracted: new Map(), listingsById: new Map(listings.map((l) => [l.id, l])), privateInputs: [] };
    const pending = async () => (await pg.query(
      `SELECT user_id, change_json->'change'->>'kind' AS kind FROM negotiations WHERE trip_id = 5 AND status = 'pending' ORDER BY user_id`,
    )).rows.map((r) => [r.user_id, r.kind]);

    // Second member's budget ask is replaced by their non-budget one.
    expect(await openNegotiations(pg, 5, [raise(A), raise(B), allow(B)], ctx)).toEqual({ outcome: 'negotiating' });
    expect(await pending()).toEqual([[A, 'raiseBudget'], [B, 'allowRoomType']]);

    // With no non-budget option, the second member is skipped (not asked for money too).
    await openNegotiations(pg, 5, [raise(A), raise(B), raise(C)], ctx);
    expect(await pending()).toEqual([[A, 'raiseBudget']]);
  });

  it('fewer nights becomes a public Plan B, with no private asks', async () => {
    // T3 is 2 nights. Cabin: 2 x $200 = $400 > $250 of caps, but 1 night ($200) fits.
    await pg.query(`INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type) VALUES ('Cabin', 'Sidemen', 20000, 6, 'private_rooms')`);
    const plan = await request(app).post('/api/trips/3/plan').set('Cookie', as(A));
    expect(plan.body.planB).toEqual({ nights: 1 });
    const props = await request(app).get('/api/trips/3/proposals').set('Cookie', as(C));
    expect(props.body).toMatchObject({ notice: null, planB: { nights: 1 } });
    for (const u of [A, B, C]) expect((await get(3, u)).status).toBe(404);
  });
});
