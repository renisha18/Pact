import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});
const generateText = vi.fn();
vi.mock('../src/ai/llm.js', () => {
  class AiError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.code = code;
      Object.assign(this, extra);
    }
  }
  return { generateJson: vi.fn(), generateText, AiError, aiMode: () => 'live' };
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const { REFUSAL } = await import('../src/ai/ask.js');
const { AiError } = await import('../src/ai/llm.js');

const as = (userId) => `pact_session=${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}`;
const ask = (userId, question) =>
  request(app).post('/api/trips/1/ask').set('Cookie', as(userId)).send({ question });

beforeAll(async () => {
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Riya', 'r@pact.demo'), ('Arjun', 'a@pact.demo'), ('Zoe', 'z@pact.demo');
    INSERT INTO groups (name, invite_token, personality) VALUES ('G', 'tok', 'wholesome');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1, 1, 'organizer'), (1, 2, 'member');
    INSERT INTO trips (group_id, title, start_date, end_date, nights) VALUES (1, 'Bali bash', '2027-01-01', '2027-01-03', 2);
    INSERT INTO trip_members (trip_id, user_id, status, commitment_type) VALUES (1, 1, 'submitted', 'need_time'), (1, 2, 'invited', NULL);
    INSERT INTO private_inputs (trip_id, user_id, max_budget_cents, preferences_text, comfort_text) VALUES
      (1, 1, 13700, 'SECRET quiet rooftop yoga every single morning', 'SECRET money is very tight');
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type) VALUES ('Villa Kelapa', 'Ubud', 10000, 4, 'private_rooms');
    INSERT INTO proposals (trip_id, listing_id, total_cents, reason_text) VALUES (1, 1, 20000, 'Lovely and leafy.');
  `);
});

beforeEach(() => {
  generateText.mockReset();
});

describe('POST /api/trips/:id/ask', () => {
  it('sends only public context to the AI', async () => {
    generateText.mockResolvedValue('Villa Kelapa looks dreamy. Go vote!');
    const res = await ask(2, 'Which stay is winning?');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ answer: 'Villa Kelapa looks dreamy. Go vote!' });

    const [system, content] = generateText.mock.calls[0];
    expect(content).toMatch(/Bali bash/);
    expect(content).toMatch(/Villa Kelapa/);
    expect(content).toMatch(/Riya/);
    for (const f of [/137/, /SECRET/, /need_time/, /max_budget/, /share/i]) expect(content).not.toMatch(f);
    expect(system).toMatch(/Never guess or hint/);
    expect(system).toMatch(/wholesome|warm, kind/);
  });

  it('replaces a leaking answer with the playful refusal', async () => {
    generateText.mockResolvedValue("Riya's budget of $137 is the smallest.");
    expect((await ask(2, 'Who has the smallest budget?')).body.answer).toBe(REFUSAL);

    generateText.mockResolvedValue('She said quiet rooftop yoga every single morning.');
    expect((await ask(2, 'What did Riya say?')).body.answer).toBe(REFUSAL);
  });

  it('returns a friendly 503 with the quota kind when the AI is out of quota', async () => {
    generateText.mockImplementation(async () => {
      throw new AiError('rate_limited', 'AI quota exceeded (daily)', { quota: 'daily', quotaId: 'X' });
    });
    const res = await ask(2, 'Which stay is winning?');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body).toEqual({
      error: 'Pact is catching its breath — try again in a minute',
      code: 'ai_unavailable',
      quota: 'daily',
    });
  });

  it('caps answers at 3 sentences', async () => {
    generateText.mockResolvedValue('One. Two! Three? Four. Five.');
    expect((await ask(1, 'hi')).body.answer).toBe('One. Two! Three?');
  });

  it('validates the question and checks membership', async () => {
    expect((await ask(1, 'x'.repeat(201))).status).toBe(400);
    expect((await ask(1, '')).status).toBe(400);
    expect((await ask(3, 'hello?')).status).toBe(404);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('rate limits to 10 per minute per user', async () => {
    generateText.mockResolvedValue('Sure!');
    // User 1 already used 1 above (the 3-sentence test); validation failures happen after the limiter.
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await ask(1, 'again?')).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
