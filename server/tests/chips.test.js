import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const generateJson = vi.fn(async () => { throw new Error('AI must not be called for chips'); });
vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});
vi.mock('../src/ai/llm.js', () => {
  class AiError extends Error {}
  return { generateJson, generateText: vi.fn(), AiError, aiMode: () => 'live' };
});

const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const { extractPreferences } = await import('../src/ai/extract.js');
const { filterListings } = await import('../src/lib/filterListings.js');

const as = (u) => `pact_session=${jwt.sign({ sub: String(u) }, process.env.JWT_SECRET)}`;
const put = (u, body) => request(app).put('/api/trips/1/private-input').set('Cookie', as(u))
  .send({ maxBudgetUsd: 500, commitmentType: 'hold', ...body });

beforeAll(async () => {
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('A','a@x'), ('B','b@x');
    INSERT INTO groups (name, invite_token) VALUES ('G', 'tok');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1,1,'organizer'), (1,2,'member');
    INSERT INTO trips (group_id, title, start_date, end_date, nights) VALUES (1, 'T', '2027-01-01', '2027-01-03', 2);
    INSERT INTO trip_members (trip_id, user_id) VALUES (1,1), (1,2);
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type, amenities, vibe_tags) VALUES
      ('Dorm Pool', 'Ubud', 5000, 4, 'mixed_dorm', '{pool,wifi}', '{party}'),
      ('Private Pool', 'Sanur', 9000, 4, 'private_rooms', '{pool,wifi,kitchen}', '{quiet}'),
      ('Private Plain', 'Canggu', 7000, 4, 'private_rooms', '{kitchen}', '{surf}');
  `);
});

describe('GET /api/vocabulary', () => {
  it('returns only values that exist in listings, with labels, and hides chips with no listing', async () => {
    const res = await request(app).get('/api/vocabulary').set('Cookie', as(1));
    expect(res.status).toBe(200);
    expect(res.body.amenities.map((a) => a.value)).toEqual(['kitchen', 'pool', 'wifi']);
    expect(res.body.vibeTags.map((a) => a.value)).toEqual(['party', 'quiet', 'surf']);
    expect(res.body.roomTypes.map((a) => a.value)).toEqual(['mixed_dorm', 'private_rooms']);
    expect(res.body.roomTypes[1].label).toBe('Private rooms');

    const chips = [...res.body.mustHave, ...res.body.niceToHave].flatMap((g) => g.chips.map((c) => c.id));
    expect(chips).toEqual(expect.arrayContaining(['private_room', 'no_mixed_dorms', 'wifi', 'kitchen', 'pool', 'vibe_quiet', 'surf']));
    expect(chips).not.toContain('shared_ok'); // no shared_rooms listing
    expect(chips).not.toContain('gym');
    expect(chips).not.toContain('breakfast');
  });

  it('requires login', async () => {
    expect((await request(app).get('/api/vocabulary')).status).toBe(401);
  });
});

describe('chips are stored and used without AI', () => {
  it('stores chips privately and rejects hidden or conflicting ones', async () => {
    expect((await put(1, { mustHaveChips: ['gym'] })).status).toBe(400);
    expect((await put(1, { mustHaveChips: ['pool'] })).status).toBe(400); // nice-to-have chip in wrong section
    expect((await put(1, { preferencesText: 'x'.repeat(201) })).status).toBe(400);

    const ok = await put(1, { mustHaveChips: ['no_mixed_dorms', 'wifi'], niceToHaveChips: ['vibe_quiet'] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ mustHaveChips: ['no_mixed_dorms', 'wifi'], niceToHaveChips: ['vibe_quiet'] });

    const mine = await request(app).get('/api/trips/1/private-input').set('Cookie', as(1));
    expect(mine.body.mustHaveChips).toEqual(['no_mixed_dorms', 'wifi']);
    const other = await request(app).get('/api/trips/1/private-input').set('Cookie', as(2));
    expect(other.body).toBeNull();
    const pub = await request(app).get('/api/trips/1').set('Cookie', as(2));
    expect(JSON.stringify(pub.body)).not.toMatch(/chips|no_mixed_dorms/i);
  });

  it('filterListings honours strict and soft chips with zero AI calls', async () => {
    await put(2, { mustHaveChips: ['wifi'], niceToHaveChips: ['pool'] });
    const extracted = await extractPreferences({ trip_id: 1, user_id: 1 });
    const other = await extractPreferences({ trip_id: 1, user_id: 2 });
    expect(extracted.hardRequirements).toEqual(['wifi']);
    expect(extracted.avoidRoomTypes).toEqual([{ type: 'mixed_dorm', strength: 'strict' }]);
    expect(extracted.softPreferences).toEqual(['quiet']);

    const { rows: listings } = await pg.query('SELECT * FROM listings ORDER BY id');
    const fits = filterListings(listings, [
      { userId: 1, capCents: 100000, extracted },
      { userId: 2, capCents: 100000, extracted: other },
    ], 2, 2);
    // Dorm excluded (strict avoid), Plain excluded (no wifi); Private Pool matches both soft chips.
    expect(fits.map((f) => f.listingId)).toEqual([2]);
    expect(fits[0].softMatchCount).toBe(2);
    expect(generateJson).not.toHaveBeenCalled();
  });
});
