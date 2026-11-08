import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});

// Extraction prompts get empty tags. The picker deliberately leaks "$137" in one
// reason (and again on regeneration) to prove leakCheck + template fallback.
const generateJson = vi.fn(async (system, content) => {
  if (system.includes('extract trip-stay preferences')) {
    return { hardRequirements: [], avoidRoomTypes: [], softPreferences: ['pool'] };
  }
  if (system.includes('Write a reason for this ONE stay')) {
    return { reason: 'Great if your cap is $137, Riya!' };
  }
  const ids = [...content.matchAll(/"listingId":(\d+)/g)].map((m) => Number(m[1]));
  return {
    picks: [
      { listingId: ids[0], reason: 'Perfect for a $137 budget of Riya.' },
      { listingId: ids[1], reason: 'Breezy rooms and a lovely garden.' },
      { listingId: ids[2], reason: 'Close to the beach with fast wifi.' },
    ],
  };
});
vi.mock('../src/ai/llm.js', () => {
  class AiError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.code = code;
      Object.assign(this, extra);
    }
  }
  return { generateJson, generateText: vi.fn(), AiError, aiMode: () => 'live' };
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');

const as = (userId) => `pact_session=${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}`;
const A = 1; // Riya, organizer, budget $137
const B = 2; // Arjun, member, budget $289
const FORBIDDEN = [/137/, /289/, /Riya/, /Arjun/, /SECRET/];
const TRIP = 1;

beforeAll(async () => {
  // Listing prices chosen so no price/total contains 137 or 289.
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Riya', 'r@pact.demo'), ('Arjun', 'a@pact.demo');
    INSERT INTO groups (name, invite_token, personality) VALUES ('G', 'tok', 'savage');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1, 1, 'organizer'), (1, 2, 'member');
    INSERT INTO trips (group_id, title, start_date, end_date, nights) VALUES (1, 'T', '2027-01-01', '2027-01-03', 2);
    INSERT INTO trip_members (trip_id, user_id) VALUES (1, 1), (1, 2);
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type, amenities, vibe_tags, emoji) VALUES
      ('Villa Kelapa', 'Ubud', 10000, 4, 'private_rooms', '{pool,wifi}', '{quiet}', '🌴'),
      ('Surf Shack', 'Canggu', 8000, 4, 'shared_rooms', '{wifi}', '{surf}', '🏄'),
      ('Garden House', 'Sanur', 12000, 4, 'private_rooms', '{kitchen}', '{nature}', '🌺'),
      ('Palace', 'Seminyak', 90000, 4, 'private_rooms', '{pool}', '{luxury}', '👑');
  `);
});

async function submit(userId, usd, text) {
  const res = await request(app)
    .put(`/api/trips/${TRIP}/private-input`)
    .set('Cookie', as(userId))
    .send({ maxBudgetUsd: usd, preferencesText: text, comfortText: `${text} comfort`, commitmentType: 'hold' });
  expect(res.status).toBe(200);
}

describe('planning flow', () => {
  it('400s with a count (no names) while someone has not submitted', async () => {
    await submit(A, 137, 'SECRET-A wants a pool and quiet nights');
    const res = await request(app).post(`/api/trips/${TRIP}/plan`).set('Cookie', as(A));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 member/);
    expect(res.body.error).not.toMatch(/Arjun/);
  });

  it('non-organizer gets 403 on plan', async () => {
    await submit(B, 289, 'SECRET-B loves surfing all day long');
    const res = await request(app).post(`/api/trips/${TRIP}/plan`).set('Cookie', as(B));
    expect(res.status).toBe(403);
  });

  it('plan and proposals never contain budgets, names or member text', async () => {
    const plan = await request(app).post(`/api/trips/${TRIP}/plan`).set('Cookie', as(A));
    expect(plan.status).toBe(200);
    expect(plan.body.status).toBe('voting');
    expect(plan.body.proposals).toHaveLength(3);

    const props = await request(app).get(`/api/trips/${TRIP}/proposals`).set('Cookie', as(B));
    expect(props.status).toBe(200);
    for (const body of [plan.body, props.body]) {
      const text = JSON.stringify(body);
      for (const f of FORBIDDEN) expect(text).not.toMatch(f);
    }
    expect(Object.keys(props.body.proposals[0]).sort()).toEqual(
      ['amenities', 'area', 'emoji', 'id', 'listingName', 'pricePerNightCents', 'reason', 'totalCents', 'voteCount'].sort(),
    );
    expect(props.body.proposals.map((p) => p.listingName)).not.toContain('Palace'); // over budget

    // The picker never saw budgets, names or member text.
    const pickerCalls = generateJson.mock.calls.filter(([s]) => !s.includes('extract trip-stay'));
    expect(pickerCalls.length).toBeGreaterThan(0);
    for (const [sys, content] of pickerCalls) {
      for (const f of FORBIDDEN) expect(sys + content).not.toMatch(f);
    }

    const { rows } = await pg.query('SELECT action, details FROM event_log WHERE trip_id = $1', [TRIP]);
    expect(rows.map((r) => r.action)).toContain('plan');
    for (const f of FORBIDDEN) expect(JSON.stringify(rows)).not.toMatch(f);
  });

  it('picks the winner when everyone has voted and stores private shares', async () => {
    const { body } = await request(app).get(`/api/trips/${TRIP}/proposals`).set('Cookie', as(A));
    const [p1, p2] = body.proposals;

    expect((await request(app).get(`/api/trips/${TRIP}/my-share`).set('Cookie', as(A))).status).toBe(404);

    let r = await request(app).post(`/api/trips/${TRIP}/votes`).set('Cookie', as(A)).send({ proposalId: p2.id });
    expect(r.body.status).toBe('voting');
    r = await request(app).post(`/api/trips/${TRIP}/votes`).set('Cookie', as(A)).send({ proposalId: p1.id }); // change vote
    r = await request(app).post(`/api/trips/${TRIP}/votes`).set('Cookie', as(B)).send({ proposalId: p2.id });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('committing');

    // 1-1 tie -> cheaper wins.
    const cheaper = p1.totalCents <= p2.totalCents ? p1 : p2;
    expect(r.body.winningProposalId).toBe(cheaper.id);

    const a = await request(app).get(`/api/trips/${TRIP}/my-share`).set('Cookie', as(A));
    const b = await request(app).get(`/api/trips/${TRIP}/my-share`).set('Cookie', as(B));
    expect(Object.keys(a.body).sort()).toEqual(['amountCents', 'totalCents']);
    expect(a.body.totalCents).toBe(cheaper.totalCents);
    expect(a.body.amountCents + b.body.amountCents).toBe(cheaper.totalCents);
    expect(a.body.amountCents).toBeLessThanOrEqual(13700);

    const { rows } = await pg.query('SELECT status FROM trips WHERE id = $1', [TRIP]);
    expect(rows[0].status).toBe('committing');
  });

  it('rejects votes once voting is closed', async () => {
    const res = await request(app).post(`/api/trips/${TRIP}/votes`).set('Cookie', as(A)).send({ proposalId: 1 });
    expect(res.status).toBe(409);
  });
});
