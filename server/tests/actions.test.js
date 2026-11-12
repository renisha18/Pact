import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const as = (id) => `pact_session=${jwt.sign({ sub: String(id) }, process.env.JWT_SECRET)}`;
const actions = (id) => request(app).get('/api/me/actions').set('Cookie', as(id));

beforeAll(async () => {
  await pg.exec(`
    INSERT INTO users (name, email, avatar_emoji) VALUES ('Riya','r@x','🌸'), ('Arjun','a@x','🌊'), ('Meera','m@x','🦊'), ('Outsider','o@x','🐢');
    INSERT INTO groups (name, invite_token) VALUES ('G', 'tok'), ('H', 'tok2');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1,1,'organizer'), (1,2,'member'), (1,3,'member'), (2,4,'organizer');
    INSERT INTO trips (group_id, title, start_date, end_date, nights, status) VALUES
      (1, 'Collect', '2027-01-01', '2027-01-03', 2, 'collecting'),
      (1, 'Vote',    '2027-02-01', '2027-02-03', 2, 'voting'),
      (1, 'Commit',  '2027-03-01', '2027-03-03', 2, 'committing'),
      (1, 'Fail',    '2027-04-01', '2027-04-03', 2, 'needs_attention');
    INSERT INTO trip_members (trip_id, user_id, status, commitment_type) VALUES
      (1,1,'invited',NULL),(1,2,'submitted','hold'),
      (2,1,'submitted','hold'),(2,2,'submitted','hold'),
      (3,1,'committed','hold'),(3,2,'committed','hold'),(3,3,'submitted','need_time'),
      (4,1,'submitted','hold');
    INSERT INTO private_inputs (trip_id, user_id, max_budget_cents) VALUES (1,2,8000);
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type) VALUES ('L','Ubud',5000,6,'private_rooms');
    INSERT INTO proposals (trip_id, listing_id, total_cents) VALUES (2,1,10000);
    INSERT INTO votes (trip_id, user_id, proposal_id) VALUES (2,2,1);
    INSERT INTO shares (trip_id, user_id, amount_cents) VALUES (3,3,4000);
    INSERT INTO payments (trip_id, user_id, kind, amount_cents, status) VALUES (4,1,'hold',3000,'failed');
    INSERT INTO negotiations (trip_id, user_id, change_json, message) VALUES (1, 2, '{}', 'SECRET-ASK for Arjun only');
  `);
});

describe('GET /api/me/actions', () => {
  it('requires auth', async () => {
    expect((await request(app).get('/api/me/actions')).status).toBe(401);
  });

  it('lists only the caller\'s own to-dos', async () => {
    const res = await actions(1);
    expect(res.status).toBe(200);
    expect(res.body.map((a) => [a.tripId, a.kind]).sort()).toEqual([
      [1, 'private_details'], [2, 'vote'], [3, 'cover'], [4, 'payment_failed'],
    ]);
    for (const a of res.body) expect(Object.keys(a).sort()).toEqual(['groupId', 'groupName', 'kind', 'label', 'tripId', 'tripTitle']);
  });

  it('another user\'s pending negotiation never appears for anyone else', async () => {
    for (const u of [1, 3, 4]) {
      const body = JSON.stringify((await actions(u)).body);
      expect(body).not.toContain('negotiation');
      expect(body).not.toContain('SECRET-ASK');
    }
    const arjun = (await actions(2)).body.map((a) => [a.tripId, a.kind]);
    expect(arjun).toContainEqual([1, 'negotiation']);
    expect(arjun).not.toContainEqual([1, 'private_details']); // already submitted details
  });

  it('offers a cover only to committed members, with no names', async () => {
    const committed = (await actions(2)).body.find((a) => a.kind === 'cover');
    expect(committed).toMatchObject({ tripId: 3, groupId: 1 });
    expect(JSON.stringify(committed)).not.toContain('Meera');
    const needsTime = (await actions(3)).body;
    expect(needsTime.some((a) => a.kind === 'cover')).toBe(false);
    expect(needsTime.map((a) => a.kind)).toContain('commit');
  });

  it('non-members of a group get nothing from it', async () => {
    expect((await actions(4)).body).toEqual([]);
  });
});

describe('GET /api/groups summary', () => {
  it('adds avatars, count, latest trip and actionNeeded for the caller only', async () => {
    const a = (await request(app).get('/api/groups').set('Cookie', as(1))).body;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      memberCount: 3, memberAvatars: ['🌸', '🌊', '🦊'], latestTrip: { title: 'Fail', status: 'needs_attention' }, actionNeeded: true,
    });
    const o = (await request(app).get('/api/groups').set('Cookie', as(4))).body;
    expect(o[0]).toMatchObject({ memberCount: 1, latestTrip: null, actionNeeded: false });
  });
});
