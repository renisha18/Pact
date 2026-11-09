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
const patch = (u, body, id = 1) => request(app).patch(`/api/groups/${id}`).set('Cookie', as(u)).send(body);
const good = { name: 'New Name', emoji: '🌿', description: 'Beach trip crew', personality: 'savage' };

beforeAll(async () => {
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Org','o@x'), ('Mem','m@x'), ('Out','x@x');
    INSERT INTO groups (name, invite_token) VALUES ('G', 'tok');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1,1,'organizer'), (1,2,'member');
  `);
});

describe('PATCH /api/groups/:id', () => {
  it('404s for a non-member, 403s for a non-organizer member', async () => {
    expect((await patch(3, good)).status).toBe(404);
    expect((await patch(2, good)).status).toBe(403);
    const { rows } = await pg.query('SELECT name FROM groups WHERE id = 1');
    expect(rows[0].name).toBe('G');
  });

  it('lets the organizer update and returns the description in detail and list', async () => {
    const res = await patch(1, good);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(good);
    const detail = await request(app).get('/api/groups/1').set('Cookie', as(2));
    expect(detail.body.group).toMatchObject({ name: 'New Name', description: 'Beach trip crew' });
    const list = await request(app).get('/api/groups').set('Cookie', as(2));
    expect(list.body[0].description).toBe('Beach trip crew');
  });

  it('enforces description (≤160), name and personality validation', async () => {
    expect((await patch(1, { ...good, description: 'x'.repeat(161) })).status).toBe(400);
    expect((await patch(1, { ...good, description: 'x'.repeat(160) })).status).toBe(200);
    expect((await patch(1, { ...good, name: '' })).status).toBe(400);
    expect((await patch(1, { ...good, name: 'x'.repeat(41) })).status).toBe(400);
    expect((await patch(1, { ...good, personality: 'mean' })).status).toBe(400);
  });
});
