// Demo scenario: resets the database, seeds users + listings, then builds the group
// "Goa Gang 2.0" with a 3-night trip whose four private inputs are chosen so that,
// with the REAL filter and counterfactual code:
//   - no stay fits as-is,
//   - the smallest fix is ONE member (Meera) accepting a shared room,
//     which unlocks a stay with a pool that matches her wishes.
// Run: `npm run db:demo`. The Reset-demo route (DEMO_MODE=true) calls resetDemo() too.
// The trip is left in 'collecting' so the organizer presses "Plan" to watch it unfold.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from '../src/db.js';
import { extractionCache } from '../src/ai/extract.js';
import { filterListings } from '../src/lib/filterListings.js';
import { counterfactual } from '../src/lib/counterfactual.js';
import { windowDays } from '../src/lib/dates.js';

const TABLES = [
  'users', 'groups', 'group_members', 'listings', 'trips', 'trip_members',
  'private_inputs', 'proposals', 'votes', 'shares', 'covers', 'payments',
  'event_log', 'group_taste', 'negotiations', 'consent_overrides', 'member_availability',
];

const NIGHTS = 3;
const WINDOW_DAYS = 7; // everyone is free all week, so the plan picks the window's first 3 nights
const DAY_MS = 86_400_000;

// Zoe is seeded like the normal demo, but is not in this group.
const USERS = [
  ['Riya', '🌸'],
  ['Arjun', '🏏'],
  ['Meera', '🎨'],
  ['Kabir', '🎸'],
  ['Zoe', '🌊'],
];

// Words below are all in the listings vocabulary (listings.json). Comfort text = must-haves
// (strict); preference text = nice-to-haves (negotiable). `features`/`avoidRoomTypes` are what
// extraction produces for that text; they are stored as the cached extraction so the demo
// is identical whether the AI is live or in mock mode.
const PEOPLE = [
  {
    name: 'Riya', role: 'organizer', budgetCents: 8500, commitment: 'hold',
    comfort: { text: "I'm not comfortable in dorms. I need a room that isn't a mixed dorm.", avoidRoomTypes: ['mixed_dorm'] },
    preferences: { text: 'Good wifi, and somewhere easy to relax.', features: ['wifi'] },
  },
  {
    name: 'Arjun', role: 'member', budgetCents: 4500, commitment: 'hold',
    comfort: { text: "It has to be a budget stay. I'm saving every rupee.", features: ['budget'] },
    preferences: { text: 'A kitchen so we can cook a few meals.', features: ['kitchen'] },
  },
  {
    name: 'Meera', role: 'member', budgetCents: 7000, commitment: 'hold',
    comfort: { text: '' },
    preferences: {
      text: "I'd love a pool and a kitchen, but I'd rather not share a room.",
      features: ['pool', 'kitchen'], avoidRoomTypes: ['shared_rooms'],
    },
  },
  {
    name: 'Kabir', role: 'member', budgetCents: 5500, commitment: 'need_time',
    comfort: { text: 'It needs a party scene. This is a friends trip!', features: ['party'] },
    preferences: { text: 'Wifi for uploading music, and air conditioning.', features: ['wifi', 'air conditioning'] },
  },
];

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Runs the real filter + counterfactual on the scenario and checks the story holds. */
function verifyScenario(listings, userIds) {
  const members = PEOPLE.map((p) => ({
    userId: userIds[p.name],
    capCents: p.budgetCents,
    extracted: extractionCache(p),
  }));
  const fits = filterListings(listings, members, NIGHTS, members.length);
  if (fits.length > 0) throw new Error('Demo scenario broken: a stay already fits everyone');

  const options = counterfactual(listings, members, NIGHTS, members.length);
  const [only, ...rest] = options;
  const stay = listings.find((l) => l.id === only?.listingId);
  const ok = options.length === 1 && rest.length === 0 &&
    only.scope === 'member' && only.userId === userIds.Meera &&
    only.change.kind === 'allowRoomType' && only.change.roomType === 'shared_rooms' &&
    stay?.amenities.includes('pool') && only.matchesOwnWishes.includes('pool');
  if (!ok) throw new Error('Demo scenario broken: the smallest fix is not "Meera accepts a shared room"');
  return { stay, shareCents: only.newShareCents, wishes: only.matchesOwnWishes };
}

/**
 * Wipes every table and rebuilds the demo. Throws (and rolls back) if the scenario
 * would not produce the expected outcome with the current filter/counterfactual code.
 */
export async function resetDemo() {
  const listingsJson = JSON.parse(await readFile(new URL('./listings.json', import.meta.url), 'utf8'));

  return withTransaction(async (client) => {
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

    const userIds = {};
    for (const [name, emoji] of USERS) {
      const { rows: [u] } = await client.query(
        'INSERT INTO users (name, email, avatar_emoji) VALUES ($1, $2, $3) RETURNING id',
        [name, `${name.toLowerCase()}@pact.demo`, emoji],
      );
      userIds[name] = u.id;
    }

    for (const l of listingsJson) {
      await client.query(
        `INSERT INTO listings
           (name, region, area, price_per_night_cents, max_guests, room_type,
            amenities, vibe_tags, house_rules, emoji, description)
         VALUES ($1, 'Bali', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [l.name, l.area, l.price_per_night_cents, l.max_guests, l.room_type,
          l.amenities, l.vibe_tags, l.house_rules, l.emoji, l.description],
      );
    }
    const { rows: listings } = await client.query(
      'SELECT id, name, price_per_night_cents, max_guests, room_type, amenities, vibe_tags FROM listings ORDER BY id',
    );
    const outcome = verifyScenario(listings, userIds);

    const { rows: [group] } = await client.query(
      `INSERT INTO groups (name, emoji, personality, invite_token, created_by)
       VALUES ('Goa Gang 2.0', '🏝️', 'chill', $1, $2) RETURNING id`,
      [randomBytes(24).toString('base64url'), userIds.Riya],
    );
    for (const p of PEOPLE) {
      await client.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [
        group.id, userIds[p.name], p.role,
      ]);
    }

    const start = Date.now() + 45 * DAY_MS;
    const { rows: [trip] } = await client.query(
      // Dates stay "deciding…" until Riya presses Plan; start/end are placeholders until then.
      `INSERT INTO trips (group_id, title, region, start_date, end_date, nights, created_by,
                          window_start, window_end, dates_status)
       VALUES ($1, 'Bali with the Goa Gang', 'Bali', $2, $3, $4, $5, $2, $6, 'deciding') RETURNING id`,
      [group.id, isoDay(start), isoDay(start + NIGHTS * DAY_MS), NIGHTS, userIds.Riya, isoDay(start + WINDOW_DAYS * DAY_MS)],
    );
    for (const p of PEOPLE) {
      await client.query(
        `INSERT INTO private_inputs
           (trip_id, user_id, max_budget_cents, preferences_text, comfort_text, extracted_json)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [trip.id, userIds[p.name], p.budgetCents, p.preferences.text, p.comfort.text, JSON.stringify(extractionCache(p))],
      );
      await client.query(
        `INSERT INTO trip_members (trip_id, user_id, status, commitment_type)
         VALUES ($1, $2, 'submitted', $3)`,
        [trip.id, userIds[p.name], p.commitment],
      );
      await client.query(
        `INSERT INTO member_availability (trip_id, user_id, day) SELECT $1, $2, unnest($3::date[])`,
        [trip.id, userIds[p.name], windowDays(isoDay(start), isoDay(start + WINDOW_DAYS * DAY_MS))],
      );
    }

    return { groupId: group.id, tripId: trip.id, nights: NIGHTS, ...outcome };
  });
}

const usd = (cents) => `$${(cents / 100).toFixed(0)}`;

// Run directly: `node server/db/demoScenario.js` (or `npm run db:demo`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const r = await resetDemo();
    console.log(`Demo ready: group "Goa Gang 2.0" (id ${r.groupId}), ${r.nights}-night trip (id ${r.tripId}), all four inputs and availability submitted.`);
    console.log(`
Expected outcome when Riya presses "Plan" (log in as Riya, Meera and Kabir to follow along):
  0. Dates: everyone is free all week, so Pact picks the first 3 nights of the window.
  1. No stay fits as-is. Group sees only "Pact is working something out privately…".
  2. Only Meera gets a private question: be okay with shared rooms.
     It unlocks ${r.stay.name} (${r.wishes.join(' + ')}, your wishes), your share ${usd(r.shareCents)}.
  3. Meera accepts -> Pact re-plans -> ${r.stay.name} is proposed; everyone votes.
  4. Riya, Arjun and Meera chose "Hold now"; Kabir chose "Need more time".
  Nobody else sees Meera's question, her budget, or that she was asked.`);
  } catch (err) {
    console.error('Demo failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
