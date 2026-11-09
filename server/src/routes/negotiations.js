// PRIVATE negotiation routes: every query is scoped to req.user.id. Another
// member's negotiation id is a plain 404, same as a missing one.
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { assertTripMember, parseId } from '../lib/membership.js';
import { negotiationSelf } from '../lib/views.js';
import { buildNegotiation, insertNegotiation, otherBudgetAskPending, EXHAUSTED_MESSAGE } from '../lib/negotiations.js';
import { runPlan, logEvent, sendAiUnavailable, PLANNABLE_STATUSES, ALREADY_PLANNING_MESSAGE } from './planning.js';
import { AiError } from '../ai/llm.js';

export const negotiationsRouter = Router();
negotiationsRouter.use(requireAuth);

const MAX_BUDGET_CENTS = 1_000_000; // same ceiling as the private-input form ($10,000): sanity bound on a share
const notFound = () => new HttpError(404, 'Not found');
const EXPIRED_MESSAGE = 'This question has expired';
const expired = () => new HttpError(409, EXPIRED_MESSAGE);

async function requireTripMember(req, _res, next) {
  req.tripId = parseId(req.params.id);
  req.trip = await assertTripMember(req.tripId, req.user.id);
  next();
}

const SELECT_OWN = `
  SELECT n.id, n.change_json, n.message, n.status, n.created_at,
         l.id AS listing_id, l.name AS listing_name, l.area, l.emoji
    FROM negotiations n
    LEFT JOIN listings l ON l.id = (n.change_json->>'listingId')::int
   WHERE n.trip_id = $1 AND n.user_id = $2`;

// --- GET /:id/my-negotiation

negotiationsRouter.get('/:id/my-negotiation', requireTripMember, async (req, res) => {
  const { rows } = await query(`${SELECT_OWN} AND n.status = 'pending'
       AND n.plan_version = (SELECT active_version FROM trips WHERE id = $1) ORDER BY n.id DESC LIMIT 1`, [
    req.tripId,
    req.user.id,
  ]);
  if (rows.length === 0) throw notFound();
  res.json(negotiationSelf(rows[0]));
});

// --- POST /:id/negotiations/:nid

const responseSchema = z.strictObject({ response: z.enum(['accept', 'reject', 'another', 'more_time']) });

/** Context for writing a new message, from cached extractions (no LLM extraction call). */
async function messageContext(tripId, group) {
  const { rows: members } = await query(
    `SELECT pi.user_id, u.name, pi.max_budget_cents, pi.preferences_text, pi.comfort_text, pi.extracted_json
       FROM private_inputs pi JOIN users u ON u.id = pi.user_id
      WHERE pi.trip_id = $1`,
    [tripId],
  );
  const { rows: listings } = await query('SELECT id, name, area FROM listings');
  const tags = (e) => ({
    hardRequirements: e?.hardRequirements ?? [],
    avoidRoomTypes: e?.avoidRoomTypes ?? [],
    softPreferences: e?.softPreferences ?? [],
  });
  return {
    personality: group.personality,
    extracted: new Map(members.map((m) => [m.user_id, tags(m.extracted_json)])),
    listingsById: new Map(listings.map((l) => [l.id, l])),
    privateInputs: members,
  };
}

/**
 * Locks the trip, then the member's own negotiation, and checks it is still answerable:
 * pending, from the active plan, and the member's input unchanged since it was asked
 * (compared in SQL, full precision). Lock order trip -> negotiation everywhere.
 */
async function lockOpenNegotiation(client, tripId, userId, nid) {
  const { rows: [t] } = await client.query('SELECT status FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
  const { rows: [n] } = await client.query(
    `SELECT n.id, n.status, n.plan_version, n.change_json,
            (n.plan_version = t.active_version) AS current,
            (n.input_updated_at IS NOT NULL AND n.input_updated_at = pi.updated_at) AS fresh
       FROM negotiations n
       JOIN trips t ON t.id = n.trip_id
       LEFT JOIN private_inputs pi ON pi.trip_id = n.trip_id AND pi.user_id = n.user_id
      WHERE n.id = $1 AND n.trip_id = $2 AND n.user_id = $3
      FOR UPDATE OF n`,
    [nid, tripId, userId],
  );
  if (!n) throw notFound();
  if (n.status !== 'pending' || !n.current || !n.fresh || !PLANNABLE_STATUSES.includes(t.status)) throw expired();
  return n;
}

/** The member said no: 'rejected' (never re-asked). Public notice if nothing is left. */
async function declineAndMaybeExhaust(tripId, userId, nid) {
  await withTransaction(async (client) => {
    await lockOpenNegotiation(client, tripId, userId, nid);
    await client.query(`UPDATE negotiations SET status = 'rejected', responded_at = now() WHERE id = $1`, [nid]);
  });
  const { rows } = await query(
    `SELECT 1 FROM negotiations n JOIN trips t ON t.id = n.trip_id
      WHERE n.trip_id = $1 AND n.status = 'pending' AND n.plan_version = t.active_version LIMIT 1`,
    [tripId],
  );
  if (rows.length > 0) return null;
  await logEvent({ query }, tripId, null, 'negotiation_exhausted');
  return EXHAUSTED_MESSAGE;
}

negotiationsRouter.post('/:id/negotiations/:nid', requireTripMember, validateBody(responseSchema), async (req, res) => {
  const nid = parseId(req.params.nid);
  const { rows } = await query(`${SELECT_OWN} AND n.id = $3`, [req.tripId, req.user.id, nid]);
  if (rows.length === 0) throw notFound();
  // Cheap pre-check (no lock); every write below re-checks under FOR UPDATE.
  const c = (await withTransaction((client) => lockOpenNegotiation(client, req.tripId, req.user.id, nid))).change_json;
  const { response } = req.body;

  if (response === 'more_time') {
    if (c.change.kind !== 'raiseBudget') throw new HttpError(400, 'Not available for this ask');
    return res.json({ response: 'more_time' });
  }

  // One budget ask per shortfall: a budget alternative is dropped while someone else's is open.
  const noAlternative = c.isAlternative || !c.alternative ||
    (c.alternative.change.kind === 'raiseBudget' && await otherBudgetAskPending({ query }, req.tripId, req.user.id));
  if (response === 'reject' || (response === 'another' && noAlternative)) {
    const notice = await declineAndMaybeExhaust(req.tripId, req.user.id, nid);
    return res.json({ response: 'reject', ...(notice ? { notice } : {}) });
  }

  if (response === 'another') {
    const { rows: [group] } = await query('SELECT personality FROM groups WHERE id = $1', [req.trip.group_id]);
    const ctx = await messageContext(req.tripId, group);
    // The AI message is written outside the transaction; the swap is atomic.
    const built = await buildNegotiation({
      userId: req.user.id, option: c.alternative, alternative: null, isAlternative: true, ctx,
    });
    await withTransaction(async (client) => {
      const n = await lockOpenNegotiation(client, req.tripId, req.user.id, nid);
      await client.query(`UPDATE negotiations SET status = 'rejected', responded_at = now() WHERE id = $1`, [nid]);
      await insertNegotiation(client, req.tripId, n.plan_version, built);
    });
    const { rows: [next] } = await query(`${SELECT_OWN} AND n.status = 'pending' ORDER BY n.id DESC LIMIT 1`, [
      req.tripId,
      req.user.id,
    ]);
    return res.json({ response: 'another', negotiation: negotiationSelf(next) });
  }

  // accept: record consent for EXACTLY the listing and share shown. Never edits private_inputs.
  await withTransaction(async (client) => {
    const n = await lockOpenNegotiation(client, req.tripId, req.user.id, nid);
    const listingId = c.listingId;
    const share = c.newShareCents;
    if (!Number.isInteger(listingId) || !Number.isInteger(share) || share < 0 || share > MAX_BUDGET_CENTS) throw expired();

    let kind;
    let roomType = null;
    if (c.change.kind === 'raiseBudget') {
      kind = 'budget';
    } else if (c.change.kind === 'allowRoomType') {
      const { rows: [pi] } = await client.query(
        'SELECT extracted_json FROM private_inputs WHERE trip_id = $1 AND user_id = $2',
        [req.tripId, req.user.id],
      );
      // Defence in depth: never relax a comfort ('strict') item.
      const avoids = pi?.extracted_json?.avoidRoomTypes ?? [];
      const strict = avoids.some((a) => (typeof a === 'string' ? a : a.type) === c.change.roomType &&
        (typeof a === 'string' || a.strength === 'strict'));
      if (strict) throw expired();
      kind = 'room_type';
      roomType = c.change.roomType;
    } else {
      throw expired();
    }
    await client.query(
      `INSERT INTO consent_overrides
         (trip_id, user_id, negotiation_id, plan_version, listing_id, kind, accepted_max_share_cents, room_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.tripId, req.user.id, nid, n.plan_version, listingId, kind, share, roomType],
    );
    await client.query(`UPDATE negotiations SET status = 'accepted', responded_at = now() WHERE id = $1`, [nid]);
  });

  try {
    const plan = await runPlan(req.tripId, null);
    res.json({ response: 'accept', plan });
  } catch (err) {
    if (err instanceof AiError) return sendAiUnavailable(res, 'replan', err);
    // Accepted either way. A plan already running sees this response (responded_at) and re-runs.
    if (err instanceof HttpError && err.status === 409) {
      return res.json({ response: 'accept', plan: null, message: err.message ?? ALREADY_PLANNING_MESSAGE });
    }
    throw err;
  }
});
