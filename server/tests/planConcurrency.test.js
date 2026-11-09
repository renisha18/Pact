import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});

// hooks.pick runs while a plan is "thinking" (inside the AI reason call), so a test
// can act mid-run. hooks.extractFails makes extraction throw like a Gemini 504.
const hooks = { pick: null, extractFails: false };
const { AiError } = vi.hoisted(() => ({ AiError: class AiError extends Error { constructor(code) { super(code); this.code = code; } } }));
const generateJson = vi.fn(async (system, content) => {
  if (system.includes('extract trip-stay preferences')) {
    if (hooks.extractFails) throw new AiError('upstream');
    return { features: [], avoidRoomTypes: content.includes('PREF-SHARED') ? ['shared_rooms'] : [] };
  }
  if (hooks.pick) await hooks.pick();
  const ids = [...content.matchAll(/"listingId":(\d+)/g)].map((m) => Number(m[1]));
  return { picks: ids.map((listingId) => ({ listingId, reason: 'Lovely spot.' })) };
});
vi.mock('../src/ai/llm.js', () => ({
  generateJson, generateText: vi.fn(async () => 'Small idea for you.'), AiError, aiMode: () => 'live',
}));

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');

const as = (userId) => `pact_session=${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}`;
const A = 1; // organizer
const B = 2;
// Plans run as A in the first block and B (co-organizer) in the second: the plan route allows 10/min per user.
let planner = A;
const plan = (trip) => request(app).post(`/api/trips/${trip}/plan`).set('Cookie', as(planner));
const proposals = (trip) => request(app).get(`/api/trips/${trip}/proposals`).set('Cookie', as(B));
const myAsk = (trip, u) => request(app).get(`/api/trips/${trip}/my-negotiation`).set('Cookie', as(u));
const respond = (trip, nid, u, response) =>
  request(app).post(`/api/trips/${trip}/negotiations/${nid}`).set('Cookie', as(u)).send({ response });
const submit = (trip, u, usd, pref = 'likes wifi') =>
  request(app).put(`/api/trips/${trip}/private-input`).set('Cookie', as(u))
    .send({ maxBudgetUsd: usd, preferencesText: pref, comfortText: '', commitmentType: 'hold' });
const releaseClaim = (trip) => pg.query('UPDATE trips SET planning_started_at = NULL WHERE id = $1', [trip]);

/** Starts a plan and resolves once it is blocked inside the AI call; returns {done, release}. */
function startBlockedPlan(trip) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const inside = new Promise((r) => { entered = r; });
  hooks.pick = async () => { hooks.pick = null; entered(); await gate; };
  const done = plan(trip).then((r) => r);
  return { done, release, inside };
}

beforeAll(async () => {
  // Trips 1-4 fit (cheap private room). Trip 5: only a shared room fits, B prefers to avoid it.
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Riya', 'r@pact.demo'), ('Arjun', 'a@pact.demo');
    INSERT INTO groups (name, invite_token, personality) VALUES ('G', 'tok', 'chill');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1, 1, 'organizer'), (1, 2, 'organizer');
    INSERT INTO trips (group_id, title, start_date, end_date, nights) VALUES
      (1, 'T1', '2027-01-01', '2027-01-02', 1), (1, 'T2', '2027-02-01', '2027-02-02', 1),
      (1, 'T3', '2027-03-01', '2027-03-02', 1), (1, 'T4', '2027-04-01', '2027-04-02', 1),
      (1, 'T5', '2027-05-01', '2027-05-02', 1);
    INSERT INTO trip_members (trip_id, user_id)
      SELECT t, u FROM generate_series(1, 5) t, generate_series(1, 2) u;
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type, amenities) VALUES
      ('Cosy Room', 'Ubud', 8000, 4, 'private_rooms', '{wifi}'),
      ('Garden Room', 'Sanur', 9000, 4, 'private_rooms', '{wifi}'),
      ('Shared Loft', 'Canggu', 6000, 4, 'shared_rooms', '{wifi}'),
      ('Big Villa', 'Ubud', 40000, 4, 'private_rooms', '{pool}');
  `);
  for (const trip of [1, 2, 3, 4]) for (const u of [A, B]) expect((await submit(trip, u, 100)).status).toBe(200);
  // Trip 5: caps $70 total -> only Shared Loft ($60) is affordable, and B would rather avoid shared rooms.
  expect((await submit(5, A, 35)).status).toBe(200);
  expect((await submit(5, B, 35, 'PREF-SHARED own room please')).status).toBe(200);
});

beforeEach(() => {
  hooks.pick = null;
  hooks.extractFails = false;
});

describe('planning concurrency', () => {
  it('two concurrent plans: one wins, the other gets 409', async () => {
    const first = startBlockedPlan(1);
    await first.inside;
    const second = await plan(1);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('Pact is already planning');
    first.release();
    const res = await first.done;
    expect(res.status).toBe(200);
    expect(res.body.proposals.length).toBeGreaterThan(0);
    // The claim is freed after a successful save.
    expect((await plan(1)).status).toBe(200);
  });

  it('a failed plan keeps old proposals valid and frees the claim', async () => {
    const before = (await proposals(1)).body.proposals.map((p) => p.id);
    await pg.query('UPDATE private_inputs SET extracted_json = NULL WHERE trip_id = 1'); // force an AI call
    hooks.extractFails = true;
    expect((await plan(1)).status).toBe(503);
    expect((await proposals(1)).body.proposals.map((p) => p.id)).toEqual(before);
    const vote = await request(app).post('/api/trips/1/votes').set('Cookie', as(A)).send({ proposalId: before[0] });
    expect(vote.status).toBe(200);
    hooks.extractFails = false;
    expect((await plan(1)).status).toBe(200); // not stuck "already planning"
  });

  it('votes only count for proposals of the active plan', async () => {
    const old = (await proposals(1)).body.proposals;
    await request(app).post('/api/trips/1/votes').set('Cookie', as(A)).send({ proposalId: old[0].id });
    await pg.query('UPDATE private_inputs SET updated_at = now() WHERE trip_id = 1 AND user_id = $1', [A]);
    expect((await plan(1)).status).toBe(200);
    const fresh = (await proposals(1)).body;
    expect(fresh.myVoteProposalId).toBeNull();
    expect(fresh.proposals.map((p) => p.id)).not.toContain(old[0].id);
    const vote = await request(app).post('/api/trips/1/votes').set('Cookie', as(B)).send({ proposalId: old[0].id });
    expect(vote.status).toBe(400);
    // Old-version proposals are never counted, even if a row survives.
    await pg.query(
      `INSERT INTO proposals (trip_id, listing_id, total_cents, plan_version) VALUES (1, 1, 8000, 0)`,
    );
    const { rows: [stale] } = await pg.query('SELECT id FROM proposals WHERE plan_version = 0 AND trip_id = 1');
    expect((await request(app).post('/api/trips/1/votes').set('Cookie', as(B)).send({ proposalId: stale.id })).status).toBe(400);
    expect((await proposals(1)).body.proposals.map((p) => p.id)).not.toContain(stale.id);
  });

  it('an edit during a running plan discards that run and re-runs once', async () => {
    const run = startBlockedPlan(2);
    await run.inside;
    expect((await submit(2, B, 120)).status).toBe(200);
    const picksBefore = generateJson.mock.calls.length;
    run.release();
    const res = await run.done;
    expect(res.status).toBe(200);
    // Re-run happened (another AI pick call) and saved; the first run wrote nothing.
    expect(generateJson.mock.calls.length).toBeGreaterThan(picksBefore);
    const { rows } = await pg.query(
      `SELECT DISTINCT p.plan_version, t.active_version, t.plan_version AS claimed, t.planning_started_at
         FROM proposals p JOIN trips t ON t.id = p.trip_id WHERE p.trip_id = 2`,
    );
    expect(rows).toEqual([{ plan_version: 2, active_version: 2, claimed: 2, planning_started_at: null }]);
  });

  it('still stale after the automatic re-run -> 409, nothing saved', async () => {
    let edits = 0;
    const editMidRun = async () => { edits += 1; await submit(3, B, 100 + edits); };
    hooks.pick = async () => { hooks.pick = editMidRunAgain; await editMidRun(); };
    const editMidRunAgain = async () => { hooks.pick = null; await editMidRun(); };
    const res = await plan(3);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Plans changed while Pact was thinking — try again');
    expect(edits).toBe(2);
    const { rows: [t] } = await pg.query('SELECT active_version, planning_started_at FROM trips WHERE id = 3');
    expect(t).toEqual({ active_version: 0, planning_started_at: null });
    expect((await proposals(3)).body.proposals).toEqual([]);
  });
});

describe('negotiation consent under concurrency', () => {
  let ask;
  beforeAll(() => { planner = B; });

  it('a no-fit plan saves a question for the active plan', async () => {
    const res = await plan(5);
    expect(res.status).toBe(200);
    ask = (await myAsk(5, B)).body;
    expect(ask.kind).toBe('allowRoomType');
  });

  it('a failed plan keeps pending questions valid', async () => {
    await pg.query('UPDATE private_inputs SET extracted_json = NULL WHERE trip_id = 5 AND user_id = $1', [A]);
    hooks.extractFails = true;
    expect((await plan(5)).status).toBe(503);
    hooks.extractFails = false;
    expect((await myAsk(5, B)).body.id).toBe(ask.id);
  });

  it('accepting a question from an outdated plan -> 409', async () => {
    await pg.query('UPDATE trips SET active_version = active_version + 1 WHERE id = 5');
    const res = await respond(5, ask.id, B, 'accept');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This question has expired');
    await pg.query('UPDATE trips SET active_version = active_version - 1 WHERE id = 5');
  });

  it('accepting after the member\'s input changed -> 409 (snapshot compared in SQL)', async () => {
    // Bump updated_at WITHOUT the route's own expiry, so only the snapshot check can catch it.
    await pg.query(`UPDATE private_inputs SET updated_at = updated_at + interval '1 microsecond' WHERE trip_id = 5 AND user_id = $1`, [B]);
    expect((await respond(5, ask.id, B, 'accept')).status).toBe(409);
    expect((await respond(5, ask.id, B, 'reject')).status).toBe(409);
    await pg.query(`UPDATE private_inputs SET updated_at = updated_at - interval '1 microsecond' WHERE trip_id = 5 AND user_id = $1`, [B]);
  });

  it('editing input then accepting -> 409', async () => {
    expect((await submit(5, B, 35, 'PREF-SHARED own room please')).status).toBe(200);
    expect((await respond(5, ask.id, B, 'accept')).status).toBe(409);
    const { rows: ov } = await pg.query('SELECT 1 FROM consent_overrides WHERE trip_id = 5 AND user_id = $1', [B]);
    expect(ov).toEqual([]);
  });

  it('accepting an expired (superseded) question -> 409; a fresh one works', async () => {
    await releaseClaim(5);
    expect((await plan(5)).status).toBe(200);
    const fresh = (await myAsk(5, B)).body;
    expect(fresh.id).not.toBe(ask.id); // edit expired the old one; not treated as a "no"
    const { rows: [old] } = await pg.query('SELECT status FROM negotiations WHERE id = $1', [ask.id]);
    expect(old.status).toBe('expired');
    expect((await respond(5, ask.id, B, 'accept')).status).toBe(409);

    const ok = await respond(5, fresh.id, B, 'accept');
    expect(ok.status).toBe(200);
    expect(ok.body.plan.status).toBe('voting');
    expect(ok.body.plan.proposals.map((p) => p.listingName)).toContain('Shared Loft');
  });

  it('accepting while another plan is running still records consent', async () => {
    await pg.query(`INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type) VALUES ('Shared Hut', 'Amed', 5000, 4, 'shared_rooms')`);
    expect((await submit(4, A, 30)).status).toBe(200);
    expect((await submit(4, B, 30, 'PREF-SHARED own room please')).status).toBe(200);
    expect((await plan(4)).status).toBe(200);
    const q = (await myAsk(4, B)).body;
    expect(q.kind).toBe('allowRoomType');

    await pg.query('UPDATE trips SET planning_started_at = now() WHERE id = 4'); // someone else is planning
    const res = await respond(4, q.id, B, 'accept');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ response: 'accept', plan: null, message: 'Pact is already planning' });
    const { rows: [n] } = await pg.query('SELECT status, responded_at FROM negotiations WHERE id = $1', [q.id]);
    expect(n.status).toBe('accepted');
    expect(n.responded_at).not.toBeNull();
  });

  it('a negotiation response during a running plan makes that run stale (re-runs once)', async () => {
    await releaseClaim(1);
    const { rows: [before] } = await pg.query('SELECT plan_version FROM trips WHERE id = 1');
    const run = startBlockedPlan(1);
    await run.inside;
    await pg.query(
      `INSERT INTO negotiations (trip_id, user_id, change_json, message, status, responded_at)
       VALUES (1, 2, '{"change":{"kind":"allowRoomType","roomType":"x"}}', 'm', 'rejected', now())`,
    );
    run.release();
    expect((await run.done).status).toBe(200);
    const { rows: [t] } = await pg.query('SELECT plan_version, active_version FROM trips WHERE id = 1');
    expect(t.plan_version).toBe(before.plan_version + 2); // first run discarded, second saved
    expect(t.active_version).toBe(t.plan_version);
  });
});
