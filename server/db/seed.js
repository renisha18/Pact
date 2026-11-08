import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pool } from '../src/db.js';

const TABLES = [
  'users', 'groups', 'group_members', 'listings', 'trips', 'trip_members',
  'private_inputs', 'proposals', 'votes', 'shares', 'covers', 'payments',
  'event_log', 'group_taste',
];

const USERS = [
  ['Riya', '🌸'],
  ['Arjun', '🏏'],
  ['Meera', '🎨'],
  ['Kabir', '🎸'],
  ['Zoe', '🌊'],
];

const listings = JSON.parse(await readFile(new URL('./listings.json', import.meta.url), 'utf8'));

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

  const userIds = {};
  for (const [name, emoji] of USERS) {
    const { rows } = await client.query(
      'INSERT INTO users (name, email, avatar_emoji) VALUES ($1, $2, $3) RETURNING id',
      [name, `${name.toLowerCase()}@pact.demo`, emoji],
    );
    userIds[name] = rows[0].id;
  }

  for (const l of listings) {
    await client.query(
      `INSERT INTO listings
         (name, region, area, price_per_night_cents, max_guests, room_type,
          amenities, vibe_tags, house_rules, emoji, description)
       VALUES ($1, 'Bali', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [l.name, l.area, l.price_per_night_cents, l.max_guests, l.room_type,
        l.amenities, l.vibe_tags, l.house_rules, l.emoji, l.description],
    );
  }

  const { rows: [group] } = await client.query(
    `INSERT INTO groups (name, emoji, personality, invite_token, created_by)
     VALUES ($1, $2, 'chill', $3, $4) RETURNING id`,
    ['Goa Gang 2.0', '🏝️', randomBytes(24).toString('base64url'), userIds.Riya],
  );

  const members = [['Riya', 'organizer'], ['Arjun', 'member'], ['Meera', 'member'], ['Kabir', 'member']];
  for (const [name, role] of members) {
    await client.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
      [group.id, userIds[name], role],
    );
  }

  await client.query('COMMIT');
  console.log(`Seeded ${USERS.length} users, ${listings.length} listings, 1 group`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Seed failed:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
