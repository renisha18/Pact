import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const USERS = {
  1: { id: 1, name: 'Riya', email: 'riya@pact.demo', avatar_emoji: '🌸', paypal_sandbox_email: null },
  5: { id: 5, name: 'Zoe', email: 'zoe@pact.demo', avatar_emoji: '🌊', paypal_sandbox_email: null },
};
const TOKEN = 'A'.repeat(32);
// Group 1 has only Riya as a member.
const MEMBERS = [{ group_id: 1, user_id: 1, role: 'organizer' }];

vi.mock('../src/db.js', () => {
  const query = vi.fn(async (sql, params = []) => {
    if (/FROM users WHERE id = \$1/.test(sql)) return { rows: USERS[params[0]] ? [USERS[params[0]]] : [] };
    if (/FROM group_members WHERE group_id = \$1 AND user_id = \$2/.test(sql)) {
      return { rows: MEMBERS.filter((m) => m.group_id === params[0] && m.user_id === params[1]) };
    }
    if (/FROM groups WHERE id = \$1/.test(sql)) {
      return { rows: [{ id: 1, name: 'Goa Gang 2.0', emoji: '🏝️', personality: 'chill', invite_token: TOKEN, created_at: '2026-11-08T00:00:00Z' }] };
    }
    if (/FROM group_members gm JOIN users u/.test(sql)) {
      return { rows: [{ id: 1, name: 'Riya', avatar_emoji: '🌸', role: 'organizer', fun_title: null, email: 'leak@x' }] };
    }
    if (/FROM trips WHERE group_id = \$1/.test(sql)) return { rows: [] };
    if (/FROM groups g WHERE g.invite_token = \$1/.test(sql)) {
      return { rows: params[0] === TOKEN ? [{ name: 'Goa Gang 2.0', emoji: '🏝️', member_count: '1', invite_token: TOKEN }] : [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { pool: {}, query, withTransaction: vi.fn() };
});

const { app } = await import('../src/index.js');
const as = (userId) => `pact_session=${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}`;

describe('groups', () => {
  it('returns 404 (not 403) to a non-member on GET /api/groups/:id', async () => {
    const res = await request(app).get('/api/groups/1').set('Cookie', as(5));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('returns the same 404 for a group that does not exist', async () => {
    const res = await request(app).get('/api/groups/999').set('Cookie', as(5));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('404s on a malformed id', async () => {
    expect((await request(app).get('/api/groups/abc').set('Cookie', as(1))).status).toBe(404);
  });

  it('shows a member the group with only whitelisted fields', async () => {
    const res = await request(app).get('/api/groups/1').set('Cookie', as(1));
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([{ id: 1, name: 'Riya', avatarEmoji: '🌸', role: 'organizer', funTitle: null }]);
    expect(res.body.group).not.toHaveProperty('invite_token');
    expect(res.body.inviteUrl).toMatch(new RegExp(`/join/${TOKEN}$`));
  });

  it('requires auth', async () => {
    expect((await request(app).get('/api/groups')).status).toBe(401);
    expect((await request(app).get(`/api/invites/${TOKEN}`)).status).toBe(401);
  });

  it('previews an invite and 404s on unknown or malformed tokens', async () => {
    const ok = await request(app).get(`/api/invites/${TOKEN}`).set('Cookie', as(5));
    expect(ok.body).toEqual({ groupName: 'Goa Gang 2.0', emoji: '🏝️', memberCount: 1 });
    expect((await request(app).get(`/api/invites/${'B'.repeat(32)}`).set('Cookie', as(5))).status).toBe(404);
    expect((await request(app).get('/api/invites/short').set('Cookie', as(5))).status).toBe(404);
  });

  it('validates the create body', async () => {
    for (const body of [{ name: '' }, { name: 'x'.repeat(41) }, { name: 'ok', personality: 'mean' }]) {
      expect((await request(app).post('/api/groups').set('Cookie', as(1)).send(body)).status).toBe(400);
    }
  });
});
