import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});
vi.mock('../src/ai/llm.js', () => {
  class AiError extends Error {}
  const generateJson = vi.fn(async (system, content) => {
    if (system.includes('extract trip-stay preferences')) return { features: [], avoidRoomTypes: [] };
    const ids = [...content.matchAll(/"listingId":(\d+)/g)].map((m) => Number(m[1]));
    return { picks: ids.map((listingId) => ({ listingId, reason: 'Lovely spot.' })) };
  });
  return { generateJson, generateText: vi.fn(async () => ''), AiError, aiMode: () => 'live' };
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const { chooseDates } = await import('../src/lib/dates.js');

const as = (u) => `pact_session=${jwt.sign({ sub: String(u) }, process.env.JWT_SECRET)}`;
const [ORG, ANA, BEN, OUT] = [1, 2, 3, 4];
const days = (a, b) => { const o = []; for (let d = a; d <= b; d++) o.push(`2027-05-${String(d).padStart(2, '0')}`); return o; };
const put = (trip, u, d) => request(app).put(`/api/trips/${trip}/availability`).set('Cookie', as(u)).send({ days: d });
const get = (trip, u) => request(app).get(`/api/trips/${trip}/availability`).set('Cookie', as(u));
const plan = (trip, u = ORG) => request(app).post(`/api/trips/${trip}/plan`).set('Cookie', as(u));

async function makeTrip() {
  const res = await request(app).post('/api/groups/1/trips').set('Cookie', as(ORG))
    .send({ title: 'Flex', windowStart: '2027-05-01', windowEnd: '2027-05-10', nights: 3 });
  expect(res.status).toBe(201);
  for (const u of [ORG, ANA, BEN]) {
    await request(app).put(`/api/trips/${res.body.id}/private-input`).set('Cookie', as(u))
      .send({ maxBudgetUsd: 900, commitmentType: 'hold' });
  }
  return res.body.id;
}

beforeAll(async () => {
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Orgname','o@x'), ('Ananame','a@x'), ('Benname','b@x'), ('Out','z@x');
    INSERT INTO groups (name, invite_token) VALUES ('G', 'tok');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1,1,'organizer'), (1,2,'member'), (1,3,'member');
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type, amenities, vibe_tags, emoji) VALUES
      ('Villa', 'Ubud', 10000, 6, 'private_rooms', '{pool}', '{quiet}', '🌴'),
      ('Hut', 'Canggu', 8000, 6, 'private_rooms', '{wifi}', '{surf}', '🏄'),
      ('House', 'Sanur', 12000, 6, 'private_rooms', '{kitchen}', '{nature}', '🌺');
  `);
});

describe('chooseDates (pure)', () => {
  const av = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  it('picks the earliest run of N nights where everyone is free', () => {
    // 2 nights = 3 calendar days. A: 1-3,5-9  B: 2-9  -> first common 3-day run is 5..7? check 2..3 only 2 days.
    const r = chooseDates('2027-05-01', '2027-05-10', 2, av({ a: days(1, 3).concat(days(5, 9)), b: days(2, 9) }));
    expect(r).toEqual({ kind: 'full', startDate: '2027-05-05', endDate: '2027-05-07' });
  });
  it('falls back to the top 3 windows by count, with no member identifiers', () => {
    const r = chooseDates('2027-05-01', '2027-05-06', 2, av({ alice: days(1, 3), bob: days(4, 6), carol: days(1, 3) }));
    expect(r.kind).toBe('fallback');
    expect(r.options).toHaveLength(3);
    expect(r.options[0]).toEqual({ startDate: '2027-05-01', endDate: '2027-05-03', availableCount: 2, total: 3 });
    expect(JSON.stringify(r)).not.toMatch(/alice|bob|carol/);
  });
});

describe('availability is owner-only', () => {
  let trip;
  beforeAll(async () => { trip = await makeTrip(); });

  it('stores days privately and never shows them to other members', async () => {
    expect((await put(trip, ANA, days(2, 4))).status).toBe(200);
    const mine = await get(trip, ANA);
    expect(mine.body.days).toEqual(days(2, 4));
    const theirs = await get(trip, BEN);
    expect(theirs.body.days).toEqual([]);
    for (const u of [ORG, BEN]) {
      const t = await request(app).get(`/api/trips/${trip}`).set('Cookie', as(u));
      expect(JSON.stringify(t.body)).not.toMatch(/2027-05-0[234]\b.*availab|availab/i);
      expect(JSON.stringify(t.body.members)).not.toMatch(/day/i);
    }
  });

  it('404s for non-members and rejects days outside the window', async () => {
    expect((await get(trip, OUT)).status).toBe(404);
    expect((await put(trip, OUT, days(2, 3))).status).toBe(404);
    expect((await put(trip, ANA, ['2027-06-01'])).status).toBe(400);
  });

  it('shows "Dates: deciding" data until chosen', async () => {
    const t = await request(app).get(`/api/trips/${trip}`).set('Cookie', as(ANA));
    expect(t.body.trip).toMatchObject({ datesStatus: 'deciding', startDate: null, endDate: null });
  });
});

describe('planning picks dates before filtering stays', () => {
  it('chooses the earliest full-overlap run', async () => {
    const trip = await makeTrip();
    await put(trip, ORG, days(1, 10));
    await put(trip, ANA, days(3, 10));
    await put(trip, BEN, days(2, 6).concat(days(8, 10)));
    const res = await plan(trip);
    expect(res.status).toBe(200);
    const t = await request(app).get(`/api/trips/${trip}`).set('Cookie', as(ANA));
    // 3 nights = 4 days; common days: 3-6 and 8-10 -> earliest 3..6
    expect(t.body.trip).toMatchObject({ datesStatus: 'chosen', startDate: '2027-05-03', endDate: '2027-05-06' });
  });

  it('asks everyone to share days first', async () => {
    const trip = await makeTrip();
    await put(trip, ORG, days(1, 10));
    const res = await plan(trip);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 members still need to share their days/);
  });

  it('offers top-3 windows by count only, organizer picks, absent members get a private nudge', async () => {
    const trip = await makeTrip();
    await put(trip, ORG, days(1, 5));
    await put(trip, ANA, days(1, 5));
    await put(trip, BEN, days(7, 10));
    const res = await plan(trip);
    expect(res.status).toBe(200);
    expect(res.body.dateOptions).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/Orgname|Ananame|Benname/);
    const shown = await get(trip, BEN);
    expect(shown.body.options[0]).toEqual({ startDate: '2027-05-01', endDate: '2027-05-04', availableCount: 2, total: 3 });
    expect(Object.keys(shown.body.options[0]).sort()).toEqual(['availableCount', 'endDate', 'startDate', 'total']);

    expect((await request(app).post(`/api/trips/${trip}/dates`).set('Cookie', as(ANA)).send({ startDate: '2027-05-01' })).status).toBe(403);
    expect((await request(app).post(`/api/trips/${trip}/dates`).set('Cookie', as(ORG)).send({ startDate: '2027-05-09' })).status).toBe(400);
    const pick = await request(app).post(`/api/trips/${trip}/dates`).set('Cookie', as(ORG)).send({ startDate: '2027-05-01' });
    expect(pick.body).toEqual({ startDate: '2027-05-01', endDate: '2027-05-04' });

    expect((await get(trip, BEN)).body.nudge).toBeTruthy(); // Ben isn't free then
    expect((await get(trip, ANA)).body.nudge).toBeNull();
    expect((await put(trip, ANA, days(1, 3))).status).toBe(409); // dates are chosen now
  });
});
