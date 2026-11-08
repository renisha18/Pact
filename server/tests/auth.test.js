import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const USERS = [
  { id: 1, name: 'Riya', email: 'riya@pact.demo', avatar_emoji: '🌸', paypal_sandbox_email: null },
  { id: 2, name: 'Arjun', email: 'arjun@pact.demo', avatar_emoji: '🏏', paypal_sandbox_email: null },
];

vi.mock('../src/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    if (/FROM users WHERE id = \$1/.test(sql)) return { rows: USERS.filter((u) => u.id === params[0]) };
    if (/FROM users ORDER BY id/.test(sql)) return { rows: USERS };
    throw new Error(`unexpected query: ${sql}`);
  }),
}));

const { app } = await import('../src/index.js');

const sessionCookie = (res) => res.headers['set-cookie']?.find((c) => c.startsWith('pact_session='));

describe('demo auth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists demo users with public fields only', async () => {
    const res = await request(app).get('/api/auth/demo-users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, name: 'Riya', avatarEmoji: '🌸' },
      { id: 2, name: 'Arjun', avatarEmoji: '🏏' },
    ]);
  });

  it('logs in, sets an httpOnly lax cookie, and /api/me works', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/demo-login').send({ userId: 1 });
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/);

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      id: 1, name: 'Riya', email: 'riya@pact.demo', avatarEmoji: '🌸', paypalSandboxEmail: null,
    });
  });

  it('logout clears the cookie', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/demo-login').send({ userId: 1 });
    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(204);
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('/api/me is 401 without a session', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not logged in' });
  });

  it('rejects tampered, wrongly-signed and expired tokens', async () => {
    const bad = [
      'garbage',
      jwt.sign({ sub: '1' }, 'wrong-secret'),
      jwt.sign({ sub: '1' }, process.env.JWT_SECRET, { expiresIn: -10 }),
      jwt.sign({ sub: '1' }, '', { algorithm: 'none' }),
    ];
    for (const token of bad) {
      const res = await request(app).get('/api/me').set('Cookie', `pact_session=${token}`);
      expect(res.status).toBe(401);
    }
  });

  it('401s when the session user no longer exists', async () => {
    const token = jwt.sign({ sub: '999' }, process.env.JWT_SECRET);
    const res = await request(app).get('/api/me').set('Cookie', `pact_session=${token}`);
    expect(res.status).toBe(401);
  });

  it('validates the login body', async () => {
    for (const body of [{}, { userId: '1' }, { userId: 1.5 }, { userId: 1, admin: true }]) {
      const res = await request(app).post('/api/auth/demo-login').send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request body' });
    }
  });

  it('404s for an unknown user', async () => {
    const res = await request(app).post('/api/auth/demo-login').send({ userId: 999 });
    expect(res.status).toBe(404);
  });

  it('rejects bodies over 50kb', async () => {
    const res = await request(app)
      .post('/api/auth/demo-login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ userId: 1, pad: 'x'.repeat(60 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('rate limits /api/auth to 30 per minute', async () => {
    // Earlier tests already used part of the budget; hammer until limited.
    let limited;
    for (let i = 0; i < 31 && !limited; i++) {
      const res = await request(app).get('/api/auth/demo-users');
      if (res.status === 429) limited = res;
    }
    expect(limited?.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests, slow down' });
    // /api/me is not covered by the auth limiter.
    expect((await request(app).get('/api/me')).status).toBe(401);
  });
});
