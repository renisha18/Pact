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
import { insertNegotiation, EXHAUSTED_MESSAGE } from '../lib/negotiations.js';
import { runPlan, logEvent, sendAiUnavailable, PLANNABLE_STATUSES } from './planning.js';
import { AiError } from '../ai/llm.js';

export const negotiationsRouter = Router();
negotiationsRouter.use(requireAuth);

const MAX_BUDGET_CENTS = 1_000_000; // same ceiling as the private-input form ($10,000)
const notFound = () => new HttpError(404, 'Not found');

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
  const { rows } = await query(`${SELECT_OWN} AND n.status = 'pending' ORDER BY n.id DESC LIMIT 1`, [
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

async function expireAndMaybeExhaust(tripId, nid) {
  await query(`UPDATE negotiations SET status = 'expired' WHERE id = $1`, [nid]);
  const { rows } = await query(`SELECT 1 FROM negotiations WHERE trip_id = $1 AND status = 'pending' LIMIT 1`, [tripId]);
  if (rows.length > 0) return null;
  await logEvent({ query }, tripId, null, 'negotiation_exhausted');
  return EXHAUSTED_MESSAGE;
}

negotiationsRouter.post('/:id/negotiations/:nid', requireTripMember, validateBody(responseSchema), async (req, res) => {
  const nid = parseId(req.params.nid);
  const { rows } = await query(`${SELECT_OWN} AND n.id = $3`, [req.tripId, req.user.id, nid]);
  if (rows.length === 0) throw notFound();
  const neg = rows[0];
  if (neg.status !== 'pending') throw new HttpError(409, 'This is no longer open');
  const c = neg.change_json;
  const { response } = req.body;

  if (response === 'more_time') {
    if (c.change.kind !== 'raiseBudget') throw new HttpError(400, 'Not available for this ask');
    return res.json({ response: 'more_time' });
  }

  if (response === 'reject' || (response === 'another' && (c.isAlternative || !c.alternative))) {
    const notice = await expireAndMaybeExhaust(req.tripId, nid);
    return res.json({ response: 'reject', ...(notice ? { notice } : {}) });
  }

  if (response === 'another') {
    const { rows: [group] } = await query('SELECT personality FROM groups WHERE id = $1', [req.trip.group_id]);
    const ctx = await messageContext(req.tripId, group);
    await query(`UPDATE negotiations SET status = 'rejected' WHERE id = $1 AND status = 'pending'`, [nid]);
    await insertNegotiation({ query }, {
      tripId: req.tripId, userId: req.user.id, option: c.alternative, alternative: null, isAlternative: true, ctx,
    });
    const { rows: [next] } = await query(`${SELECT_OWN} AND n.status = 'pending' ORDER BY n.id DESC LIMIT 1`, [
      req.tripId,
      req.user.id,
    ]);
    return res.json({ response: 'another', negotiation: negotiationSelf(next) });
  }

  // accept: apply the change to this member's OWN private input, then re-plan.
  await withTransaction(async (client) => {
    const { rows: [t] } = await client.query('SELECT status FROM trips WHERE id = $1 FOR UPDATE', [req.tripId]);
    if (!PLANNABLE_STATUSES.includes(t.status)) throw new HttpError(409, 'This trip can no longer be planned');
    const { rows: [n] } = await client.query('SELECT status FROM negotiations WHERE id = $1 FOR UPDATE', [nid]);
    if (n.status !== 'pending') throw new HttpError(409, 'This is no longer open');

    if (c.change.kind === 'raiseBudget') {
      const { rowCount } = await client.query(
        `UPDATE private_inputs SET max_budget_cents = max_budget_cents + $3
          WHERE trip_id = $1 AND user_id = $2 AND max_budget_cents + $3 <= $4`,
        [req.tripId, req.user.id, c.change.byCents, MAX_BUDGET_CENTS],
      );
      if (rowCount === 0) throw new HttpError(409, "That would go over the maximum budget");
    } else if (c.change.kind === 'allowRoomType') {
      const { rows: [pi] } = await client.query(
        'SELECT extracted_json FROM private_inputs WHERE trip_id = $1 AND user_id = $2 FOR UPDATE',
        [req.tripId, req.user.id],
      );
      // Defence in depth: never relax a comfort ('strict') item.
      const avoids = pi?.extracted_json?.avoidRoomTypes ?? [];
      const strict = avoids.some((a) => (typeof a === 'string' ? a : a.type) === c.change.roomType &&
        (typeof a === 'string' || a.strength === 'strict'));
      if (strict) throw new HttpError(409, 'This is no longer open');
      await client.query(
        `UPDATE private_inputs SET allowed_room_types = array_append(allowed_room_types, $3)
          WHERE trip_id = $1 AND user_id = $2 AND NOT ($3 = ANY(allowed_room_types))`,
        [req.tripId, req.user.id, c.change.roomType],
      );
    } else {
      throw new HttpError(409, 'This is no longer open');
    }
    await client.query(`UPDATE negotiations SET status = 'accepted' WHERE id = $1`, [nid]);
  });

  try {
    const plan = await runPlan(req.tripId, null);
    res.json({ response: 'accept', plan });
  } catch (err) {
    if (err instanceof AiError) return sendAiUnavailable(res, 'replan', err);
    throw err;
  }
});
