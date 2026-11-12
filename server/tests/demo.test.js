import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});
vi.mock('../src/ai/llm.js', () => {
  class AiError extends Error {}
  // Extraction must come from the demo's cached tags, never from the AI.
  const generateJson = vi.fn(async (system, content) => {
    if (system.includes('extract trip-stay preferences')) throw new Error('demo should not call extraction');
    const ids = [...content.matchAll(/"listingId":(\d+)/g)].map((m) => Number(m[1]));
    return { picks: ids.map((listingId) => ({ listingId, reason: 'Lovely spot.' })) };
  });
  return { generateJson, generateText: vi.fn(async () => ''), AiError, aiMode: () => 'live' };
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const { resetDemo } = await import('../db/demoScenario.js');

const as = (u) => `pact_session=${jwt.sign({ sub: String(u) }, process.env.JWT_SECRET)}`;
const [RIYA, ARJUN, MEERA, KABIR, ZOE] = [1, 2, 3, 4, 5];
const myAsk = (trip, u) => request(app).get(`/api/trips/${trip}/my-negotiation`).set('Cookie', as(u));
let demo;

beforeAll(async () => { demo = await resetDemo(); });
afterAll(() => { delete process.env.DEMO_MODE; });

describe('demo scenario', () => {
  it('seeds the group, the 3-night trip and four submitted inputs', async () => {
    const { rows: members } = await pg.query(
      `SELECT u.name, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id ORDER BY u.id`);
    expect(members).toEqual([
      { name: 'Riya', role: 'organizer' }, { name: 'Arjun', role: 'member' },
      { name: 'Meera', role: 'member' }, { name: 'Kabir', role: 'member' },
    ]);
    const { rows: [t] } = await pg.query('SELECT nights, status FROM trips WHERE id = $1', [demo.tripId]);
    expect(t).toEqual({ nights: 3, status: 'collecting' });
    const { rows: tm } = await pg.query(
      'SELECT u.name, tm.status, tm.commitment_type FROM trip_members tm JOIN users u ON u.id = tm.user_id ORDER BY u.id');
    expect(tm).toEqual([
      { name: 'Riya', status: 'submitted', commitment_type: 'hold' },
      { name: 'Arjun', status: 'submitted', commitment_type: 'hold' },
      { name: 'Meera', status: 'submitted', commitment_type: 'hold' },
      { name: 'Kabir', status: 'submitted', commitment_type: 'need_time' },
    ]);
  });

  it('no stay fits as-is; only Meera is asked, about a shared room that unlocks a pool stay', async () => {
    const plan = await request(app).post(`/api/trips/${demo.tripId}/plan`).set('Cookie', as(RIYA));
    expect(plan.status).toBe(200);
    expect(plan.body).toEqual({ status: 'collecting', proposals: [], message: 'Pact is working something out privately…' });

    const ask = (await myAsk(demo.tripId, MEERA)).body;
    expect(ask).toMatchObject({
      kind: 'allowRoomType', roomType: 'shared_rooms', stay: { name: 'Kayu Aya Shared House' },
      newShareCents: 5250,
    });
    expect(ask.matchesOwnWishes).toContain('pool');
    for (const u of [RIYA, ARJUN, KABIR]) expect((await myAsk(demo.tripId, u)).status).toBe(404);
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM negotiations`);
    expect(rows[0].n).toBe(1);
  });

  it('Meera accepts -> the pool stay is proposed, everyone can vote, everyone pays the same share, within every budget', async () => {
    const ask = (await myAsk(demo.tripId, MEERA)).body;
    const res = await request(app).post(`/api/trips/${demo.tripId}/negotiations/${ask.id}`)
      .set('Cookie', as(MEERA)).send({ response: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.plan.proposals.map((p) => p.listingName)).toEqual(['Kayu Aya Shared House']);

    const pid = res.body.plan.proposals[0].id;
    for (const u of [RIYA, ARJUN, MEERA, KABIR]) {
      const v = await request(app).post(`/api/trips/${demo.tripId}/votes`).set('Cookie', as(u)).send({ proposalId: pid });
      expect(v.status).toBe(200);
    }
    const { rows } = await pg.query('SELECT user_id, amount_cents FROM shares ORDER BY user_id');
    expect(rows).toEqual([
      { user_id: RIYA, amount_cents: 5250 }, { user_id: ARJUN, amount_cents: 5250 },
      { user_id: MEERA, amount_cents: 5250 }, { user_id: KABIR, amount_cents: 5250 },
    ]);
  });
});

describe('Reset demo route', () => {
  it('is a 404 unless DEMO_MODE=true, and status says canReset=false', async () => {
    delete process.env.DEMO_MODE;
    expect((await request(app).post('/api/demo/reset').set('Cookie', as(RIYA)).send({})).status).toBe(404);
    expect((await request(app).get('/api/demo/status').set('Cookie', as(RIYA))).body).toEqual({ canReset: false });
    expect((await request(app).post('/api/demo/reset').send({})).status).toBe(401);
  });

  it('organizer-only when enabled; resets to the starting scenario', async () => {
    process.env.DEMO_MODE = 'true';
    expect((await request(app).get('/api/demo/status').set('Cookie', as(RIYA))).body).toEqual({ canReset: true });
    expect((await request(app).get('/api/demo/status').set('Cookie', as(MEERA))).body).toEqual({ canReset: false });
    expect((await request(app).post('/api/demo/reset').set('Cookie', as(MEERA)).send({})).status).toBe(403);
    expect((await request(app).post('/api/demo/reset').set('Cookie', as(ZOE)).send({})).status).toBe(403);
    expect((await request(app).post('/api/demo/reset').set('Cookie', as(RIYA)).send({ x: 1 })).status).toBe(400);

    const res = await request(app).post('/api/demo/reset').set('Cookie', as(RIYA)).send({});
    expect(res.status).toBe(200);
    const { rows: [t] } = await pg.query('SELECT status FROM trips WHERE id = $1', [res.body.tripId]);
    expect(t.status).toBe('collecting');
    expect((await pg.query('SELECT 1 FROM shares')).rows).toEqual([]);
    expect((await pg.query('SELECT 1 FROM negotiations')).rows).toEqual([]);
    // Sessions survive (same ids), and the story can be replayed.
    const plan = await request(app).post(`/api/trips/${res.body.tripId}/plan`).set('Cookie', as(RIYA));
    expect(plan.body.message).toBe('Pact is working something out privately…');
  });
});
