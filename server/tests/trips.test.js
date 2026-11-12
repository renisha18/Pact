import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');

const as = (userId) => `pact_session=${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}`;
const A = 1; // Riya, organizer
const B = 2; // Arjun, member
const OUTSIDER = 3; // Zoe, not in the group

const SECRET_INPUT = {
  maxBudgetUsd: 432.1,
  preferencesText: 'A-SECRET-PREF quiet villa',
  comfortText: 'A-SECRET-COMFORT tight on money',
  commitmentType: 'need_time',
  roastLevel: 'savage',
};

let tripId;

beforeAll(async () => {
  await pg.exec(`
    INSERT INTO users (name, email, avatar_emoji) VALUES
      ('Riya', 'riya@pact.demo', '🌸'), ('Arjun', 'arjun@pact.demo', '🏏'), ('Zoe', 'zoe@pact.demo', '🌊');
    INSERT INTO groups (name, emoji, invite_token, created_by) VALUES ('Goa Gang 2.0', '🏝️', 'tok', 1);
    INSERT INTO group_members (group_id, user_id, role) VALUES (1, 1, 'organizer'), (1, 2, 'member');
  `);
  const res = await request(app)
    .post('/api/groups/1/trips')
    .set('Cookie', as(A))
    .send({ title: 'Bali or bust', windowStart: '2027-03-10', windowEnd: '2027-03-20', nights: 5 });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ region: 'Bali', nights: 5, status: 'collecting' });
  tripId = res.body.id;

  const put = await request(app).put(`/api/trips/${tripId}/private-input`).set('Cookie', as(A)).send(SECRET_INPUT);
  expect(put.status).toBe(200);
  expect(put.body.maxBudgetCents).toBe(43210);
});

describe('GET /api/trips/:id public view', () => {
  it('contains no budget, preference, comfort or commitment fields', async () => {
    const res = await request(app).get(`/api/trips/${tripId}`).set('Cookie', as(B));
    expect(res.status).toBe(200);

    const text = JSON.stringify(res.body);
    for (const forbidden of [
      /budget/i, /preference/i, /comfort/i, /commitment/i, /roast/i, /extracted/i,
      /A-SECRET/, /43210/, /432\.1/, /need_time/, /savage/,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
    expect(Object.keys(res.body.members[0]).sort()).toEqual(['avatarEmoji', 'id', 'name', 'status']);
    // A's status is visible (submitted), nothing else about their input is.
    expect(res.body.members).toContainEqual({ id: A, name: 'Riya', avatarEmoji: '🌸', status: 'submitted' });
    expect(res.body.members).toContainEqual({ id: B, name: 'Arjun', avatarEmoji: '🏏', status: 'invited' });
  });

  it('never exposes another member\'s committed/commitment state; myStatus is the caller\'s own', async () => {
    const { rows: [prev] } = await pg.query('SELECT commitment_type FROM trip_members WHERE trip_id = $1 AND user_id = $2', [tripId, A]);
    await pg.query(`UPDATE trip_members SET status = 'committed', commitment_type = 'need_time' WHERE trip_id = $1 AND user_id = $2`, [tripId, A]);
    const asB = await request(app).get(`/api/trips/${tripId}`).set('Cookie', as(B));
    expect(asB.body.members).toContainEqual({ id: A, name: 'Riya', avatarEmoji: '🌸', status: 'submitted' });
    expect(JSON.stringify(asB.body)).not.toMatch(/committed|need_time/);
    const asA = await request(app).get(`/api/trips/${tripId}`).set('Cookie', as(A));
    expect(asA.body.myStatus).toBe('committed');
    await pg.query(`UPDATE trip_members SET status = 'submitted', commitment_type = $3 WHERE trip_id = $1 AND user_id = $2`, [tripId, A, prev.commitment_type]);
  });

  it('is 404 for someone outside the group', async () => {
    const res = await request(app).get(`/api/trips/${tripId}`).set('Cookie', as(OUTSIDER));
    expect(res.status).toBe(404);
  });
});

describe('private input isolation', () => {
  it("B cannot read A's private input", async () => {
    const res = await request(app).get(`/api/trips/${tripId}/private-input`).set('Cookie', as(B));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/A-SECRET/);
  });

  it("B cannot overwrite A's private input, even by sending A's userId", async () => {
    const attempt = await request(app)
      .put(`/api/trips/${tripId}/private-input`)
      .set('Cookie', as(B))
      .send({ ...SECRET_INPUT, userId: A, maxBudgetUsd: 1, preferencesText: 'HIJACKED' });
    expect(attempt.status).toBe(400); // unknown field rejected

    const own = await request(app)
      .put(`/api/trips/${tripId}/private-input`)
      .set('Cookie', as(B))
      .send({ maxBudgetUsd: 1, preferencesText: 'B-OWN', commitmentType: 'hold' });
    expect(own.status).toBe(200);

    const a = await request(app).get(`/api/trips/${tripId}/private-input`).set('Cookie', as(A));
    expect(a.body).toMatchObject({
      maxBudgetCents: 43210,
      preferencesText: SECRET_INPUT.preferencesText,
      comfortText: SECRET_INPUT.comfortText,
      commitmentType: 'need_time',
      roastLevel: 'savage',
    });

    const { rows } = await pg.query('SELECT user_id, max_budget_cents FROM private_inputs ORDER BY user_id');
    expect(rows).toEqual([{ user_id: A, max_budget_cents: 43210 }, { user_id: B, max_budget_cents: 100 }]);
  });

  it('outsiders get 404 on read and write', async () => {
    expect((await request(app).get(`/api/trips/${tripId}/private-input`).set('Cookie', as(OUTSIDER))).status).toBe(404);
    const put = await request(app)
      .put(`/api/trips/${tripId}/private-input`)
      .set('Cookie', as(OUTSIDER))
      .send({ maxBudgetUsd: 50, commitmentType: 'hold' });
    expect(put.status).toBe(404);
  });

  it('validates budget range and precision', async () => {
    for (const maxBudgetUsd of [0, 10001, 12.345, '100']) {
      const res = await request(app)
        .put(`/api/trips/${tripId}/private-input`)
        .set('Cookie', as(B))
        .send({ maxBudgetUsd, commitmentType: 'hold' });
      expect(res.status).toBe(400);
    }
  });

  it('is locked once the trip leaves collecting/planning', async () => {
    await pg.query(`UPDATE trips SET status = 'voting' WHERE id = $1`, [tripId]);
    const res = await request(app)
      .put(`/api/trips/${tripId}/private-input`)
      .set('Cookie', as(A))
      .send({ maxBudgetUsd: 999, commitmentType: 'hold' });
    expect(res.status).toBe(409);
    await pg.query(`UPDATE trips SET status = 'collecting' WHERE id = $1`, [tripId]);
  });
});

describe('POST /api/groups/:id/trips', () => {
  it('rejects bad dates and non-members', async () => {
    for (const body of [
      { title: 'x', windowStart: '2027-03-10', windowEnd: '2027-03-12', nights: 3 },
      { title: 'x', windowStart: '2027-03-10', windowEnd: '2027-03-01', nights: 1 },
      { title: 'x', windowStart: '2027-02-30', windowEnd: '2027-03-05', nights: 2 },
      { title: 'x', windowStart: '2027-03-01', windowEnd: '2027-03-30', nights: 0 },
      { title: 'x', windowStart: '2027-03-01', windowEnd: '2027-03-30', nights: 15 },
    ]) {
      expect((await request(app).post('/api/groups/1/trips').set('Cookie', as(A)).send(body)).status).toBe(400);
    }
    const res = await request(app)
      .post('/api/groups/1/trips')
      .set('Cookie', as(OUTSIDER))
      .send({ title: 'x', windowStart: '2027-03-10', windowEnd: '2027-03-14', nights: 2 });
    expect(res.status).toBe(404);
  });
});
