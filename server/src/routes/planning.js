// Plan -> proposals -> votes -> shares. All money is computed here (server-side,
// integer cents); the top 3 are chosen deterministically; the AI only writes reasons.
import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { assertTripMember, parseId } from '../lib/membership.js';
import { filterListings } from '../lib/filterListings.js';
import { fairSplit } from '../lib/fairSplit.js';
import { counterfactual } from '../lib/counterfactual.js';
import {
  openNegotiations, applyAllowedRoomTypes, negotiationNotice, WORKING_MESSAGE, EXHAUSTED_MESSAGE,
} from '../lib/negotiations.js';
import { proposalPublic } from '../lib/views.js';
import { extractAll, pickAndExplain } from '../ai/plan.js';
import { askPact } from '../ai/ask.js';
import { AiError } from '../ai/llm.js';

export const planningRouter = Router();
planningRouter.use(requireAuth);

const TOP_CANDIDATES = 8;
export const PLANNABLE_STATUSES = ['collecting', 'planning', 'voting'];
const NO_FIT_MESSAGE = 'No stay fits everyone right now. Try different dates or budgets.';

async function requireTripMember(req, _res, next) {
  req.tripId = parseId(req.params.id);
  req.trip = await assertTripMember(req.tripId, req.user.id);
  next();
}

async function requireOrganizer(req, _res, next) {
  const { rows } = await query(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND role = 'organizer'`,
    [req.trip.group_id, req.user.id],
  );
  if (rows.length === 0) throw new HttpError(403, 'Only the organizer can do that');
  next();
}

const perUserLimiter = (what) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    keyGenerator: (req) => `user:${req.user.id}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: `Too many ${what} requests, slow down` },
  });
const planLimiter = perUserLimiter('plan');
const askLimiter = perUserLimiter('ask');

export const AI_UNAVAILABLE_MESSAGE = 'Pact is catching its breath — try again in a minute';

/**
 * Friendly 503 for any AI failure. Logs only the generic code/status and, on a
 * 429, the provider's quota name. Never request or response content.
 */
export function sendAiUnavailable(res, where, err) {
  if (process.env.NODE_ENV !== 'test') {
    const quota = err.quota ? ` quota=${err.quota}${err.quotaId ? ` (${err.quotaId})` : ''}` : '';
    console.warn(`[ai:${where}] ${err.code}: ${err.message}${quota}`);
  }
  res.set('Retry-After', '60');
  res.status(503).json({
    error: AI_UNAVAILABLE_MESSAGE,
    code: 'ai_unavailable',
    ...(err.quota ? { quota: err.quota } : {}),
  });
}

/** Only ids/counts in details: never private text or budgets. */
export function logEvent(db, tripId, actorUserId, action, details = {}) {
  return db.query(
    'INSERT INTO event_log (trip_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)',
    [tripId, actorUserId, action, JSON.stringify(details)],
  );
}

async function loadProposals(tripId) {
  const { rows } = await query(
    `SELECT p.id, p.total_cents, p.reason_text,
            l.name AS listing_name, l.area, l.emoji, l.price_per_night_cents, l.amenities,
            (SELECT count(*) FROM votes v WHERE v.proposal_id = p.id) AS vote_count
       FROM proposals p JOIN listings l ON l.id = p.listing_id
      WHERE p.trip_id = $1
      ORDER BY p.id`,
    [tripId],
  );
  return rows.map(proposalPublic);
}

// --- Planning (shared by POST /:id/plan and an accepted negotiation)

const nightsText = (n) => `${n} ${n === 1 ? 'night' : 'nights'}`;

/**
 * Runs the planner for a trip. Throws HttpError for 400/409 and AiError if the AI is down.
 * @returns {Promise<{status: string, proposals: object[], message?: string, planB?: {nights: number}}>}
 *   PUBLIC: safe to return to any trip member.
 */
export async function runPlan(tripId, actorUserId) {
  const { rows: [trip] } = await query('SELECT * FROM trips WHERE id = $1', [tripId]);
  if (!PLANNABLE_STATUSES.includes(trip.status)) throw new HttpError(409, 'This trip can no longer be planned');

  // PRIVATE rows: used for filtering and leakCheck only, never returned or sent to the AI.
  const { rows: members } = await query(
    `SELECT tm.trip_id, tm.user_id, u.name,
            pi.max_budget_cents, pi.preferences_text, pi.comfort_text, pi.allowed_room_types
       FROM trip_members tm
       JOIN users u ON u.id = tm.user_id
       LEFT JOIN private_inputs pi ON pi.trip_id = tm.trip_id AND pi.user_id = tm.user_id
      WHERE tm.trip_id = $1 AND tm.status <> 'dropped'
      ORDER BY tm.user_id`,
    [tripId],
  );
  const missing = members.filter((m) => m.max_budget_cents === null).length;
  if (missing > 0) {
    throw new HttpError(400, `${missing} ${missing === 1 ? 'member still needs' : 'members still need'} to submit`);
  }

  const { rows: [group] } = await query('SELECT personality FROM groups WHERE id = $1', [trip.group_id]);
  const { rows: listings } = await query(
    `SELECT id, name, area, emoji, price_per_night_cents, max_guests, room_type,
            amenities, vibe_tags, description
       FROM listings WHERE region = $1 ORDER BY id`,
    [trip.region],
  );
  const listingsById = new Map(listings.map((l) => [l.id, l]));

  const raw = await extractAll(members);
  const extracted = new Map(members.map((m) => [m.user_id, applyAllowedRoomTypes(raw.get(m.user_id), m.allowed_room_types)]));
  const filterMembers = members.map((m) => ({
    userId: m.user_id,
    capCents: m.max_budget_cents,
    extracted: extracted.get(m.user_id),
  }));
  const candidates = filterListings(listings, filterMembers, trip.nights, members.length).slice(0, TOP_CANDIDATES);
  const picks = candidates.length > 0 ? await pickAndExplain(candidates, listingsById, group.personality, members) : [];

  if (picks.length === 0) {
    const options = counterfactual(listings, filterMembers, trip.nights, members.length);
    // No transaction: messages may call the AI. The one-pending-per-member index guards races.
    const result = await openNegotiations({ query }, tripId, options, {
      personality: group.personality, extracted, listingsById, privateInputs: members,
    });
    if (result.outcome === 'plan_b') {
      await logEvent({ query }, tripId, actorUserId, 'plan_b', { nights: result.nights });
      return {
        status: trip.status,
        proposals: [],
        planB: { nights: result.nights },
        message: `Plan B: no stay fits everyone for ${nightsText(trip.nights)}, but one does for ${nightsText(result.nights)}.`,
      };
    }
    if (result.outcome === 'negotiating') {
      await logEvent({ query }, tripId, null, 'plan_negotiating');
      return { status: trip.status, proposals: [], message: WORKING_MESSAGE };
    }
    if (result.outcome === 'exhausted') {
      await logEvent({ query }, tripId, null, 'negotiation_exhausted');
      return { status: trip.status, proposals: [], message: EXHAUSTED_MESSAGE };
    }
    await logEvent({ query }, tripId, actorUserId, 'plan_no_fit');
    return { status: trip.status, proposals: [], message: NO_FIT_MESSAGE };
  }

  const totals = new Map(candidates.map((c) => [c.listingId, c.totalCents]));
  await withTransaction(async (client) => {
    const { rows: [t] } = await client.query('SELECT status FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
    if (!PLANNABLE_STATUSES.includes(t.status)) throw new HttpError(409, 'This trip can no longer be planned');
    await client.query('DELETE FROM proposals WHERE trip_id = $1', [tripId]); // votes cascade
    for (const p of picks) {
      await client.query(
        'INSERT INTO proposals (trip_id, listing_id, total_cents, reason_text) VALUES ($1, $2, $3, $4)',
        [tripId, p.listingId, totals.get(p.listingId), p.reason],
      );
    }
    // A plan exists, so any open asks are moot.
    await client.query(`DELETE FROM negotiations WHERE trip_id = $1 AND status = 'pending'`, [tripId]);
    await client.query(`UPDATE trips SET status = 'voting', chosen_listing_id = NULL WHERE id = $1`, [tripId]);
    await logEvent(client, tripId, actorUserId, 'plan', { proposalCount: picks.length });
  });

  return { status: 'voting', proposals: await loadProposals(tripId) };
}

// --- POST /:id/plan

planningRouter.post('/:id/plan', requireTripMember, requireOrganizer, planLimiter, async (req, res) => {
  try {
    res.json(await runPlan(req.tripId, req.user.id));
  } catch (err) {
    if (err instanceof AiError) return sendAiUnavailable(res, 'plan', err);
    throw err;
  }
});

// --- GET /:id/proposals

planningRouter.get('/:id/proposals', requireTripMember, async (req, res) => {
  const { rows } = await query('SELECT proposal_id FROM votes WHERE trip_id = $1 AND user_id = $2', [
    req.tripId,
    req.user.id,
  ]);
  // Public: which proposal won (null until voting completes).
  const { rows: winner } = await query(
    `SELECT p.id FROM proposals p JOIN trips t ON t.id = p.trip_id AND t.chosen_listing_id = p.listing_id
      WHERE p.trip_id = $1`,
    [req.tripId],
  );
  const proposals = await loadProposals(req.tripId);
  res.json({
    proposals,
    // PUBLIC status while there's no plan: never says who or how many.
    ...(proposals.length === 0 ? await negotiationNotice({ query }, req.tripId) : { notice: null, planB: null }),
    myVoteProposalId: rows[0]?.proposal_id ?? null,
    winningProposalId: winner[0]?.id ?? null,
  });
});

// --- POST /:id/votes

const voteSchema = z.strictObject({ proposalId: z.number().int().positive().max(2147483647) });

planningRouter.post('/:id/votes', requireTripMember, validateBody(voteSchema), async (req, res) => {
  if (req.trip.member_status === 'dropped') throw new HttpError(409, "You've dropped out of this trip");
  const { proposalId } = req.body;

  const result = await withTransaction(async (client) => {
    const { rows: [t] } = await client.query('SELECT status FROM trips WHERE id = $1 FOR UPDATE', [req.tripId]);
    if (t.status !== 'voting') throw new HttpError(409, 'Voting is not open for this trip');

    const { rows: prop } = await client.query('SELECT id FROM proposals WHERE id = $1 AND trip_id = $2', [
      proposalId,
      req.tripId,
    ]);
    if (prop.length === 0) throw new HttpError(400, 'Unknown proposal');

    await client.query(
      `INSERT INTO votes (trip_id, user_id, proposal_id) VALUES ($1, $2, $3)
       ON CONFLICT (trip_id, user_id) DO UPDATE SET proposal_id = EXCLUDED.proposal_id`,
      [req.tripId, req.user.id, proposalId],
    );
    await logEvent(client, req.tripId, req.user.id, 'vote', { proposalId });

    // Everyone still on the trip has voted?
    const { rows: [counts] } = await client.query(
      `SELECT count(*) AS members, count(v.user_id) AS voted
         FROM trip_members tm
         LEFT JOIN votes v ON v.trip_id = tm.trip_id AND v.user_id = tm.user_id
        WHERE tm.trip_id = $1 AND tm.status <> 'dropped'`,
      [req.tripId],
    );
    if (Number(counts.voted) < Number(counts.members)) return { status: 'voting' };

    // Ranked: most votes, then cheaper, then oldest. First one the group can afford wins.
    const { rows: ranked } = await client.query(
      `SELECT p.id, p.listing_id, p.total_cents,
              (SELECT count(*) FROM votes v
                 JOIN trip_members tm ON tm.trip_id = v.trip_id AND tm.user_id = v.user_id AND tm.status <> 'dropped'
                WHERE v.proposal_id = p.id) AS vote_count
         FROM proposals p WHERE p.trip_id = $1
        ORDER BY vote_count DESC, p.total_cents ASC, p.id ASC`,
      [req.tripId],
    );
    const { rows: caps } = await client.query(
      `SELECT tm.user_id, pi.max_budget_cents
         FROM trip_members tm JOIN private_inputs pi ON pi.trip_id = tm.trip_id AND pi.user_id = tm.user_id
        WHERE tm.trip_id = $1 AND tm.status <> 'dropped'
        ORDER BY tm.user_id`,
      [req.tripId],
    );
    const capList = caps.map((c) => ({ userId: c.user_id, capCents: c.max_budget_cents }));

    for (const p of ranked) {
      const split = fairSplit(p.total_cents, capList);
      if (!split.feasible) continue;
      await client.query('DELETE FROM shares WHERE trip_id = $1', [req.tripId]);
      for (const s of split.shares) {
        await client.query('INSERT INTO shares (trip_id, user_id, amount_cents) VALUES ($1, $2, $3)', [
          req.tripId,
          s.userId,
          s.amountCents,
        ]);
      }
      await client.query(
        `UPDATE trips SET status = 'committing', chosen_listing_id = $2 WHERE id = $1`,
        [req.tripId, p.listing_id],
      );
      await logEvent(client, req.tripId, null, 'winner', { proposalId: p.id, listingId: p.listing_id });
      return { status: 'committing', winningProposalId: p.id };
    }
    await logEvent(client, req.tripId, null, 'winner_none_affordable');
    return { status: 'voting', message: 'None of these stays fits everyone any more. Ask the organizer to re-plan.' };
  });

  res.json(result);
});

// --- GET /:id/my-share  (PRIVATE: scoped to req.user.id only)

planningRouter.get('/:id/my-share', requireTripMember, async (req, res) => {
  const { rows } = await query(
    `SELECT s.amount_cents, p.total_cents
       FROM shares s
       JOIN trips t ON t.id = s.trip_id
       JOIN proposals p ON p.trip_id = t.id AND p.listing_id = t.chosen_listing_id
      WHERE s.trip_id = $1 AND s.user_id = $2
      LIMIT 1`,
    [req.tripId, req.user.id],
  );
  if (rows.length === 0) throw new HttpError(404, 'No share yet');
  res.json({ amountCents: rows[0].amount_cents, totalCents: rows[0].total_cents });
});

// --- POST /:id/ask  (context is PUBLIC data only)

const askSchema = z.strictObject({ question: z.string().trim().min(1).max(200) });
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

planningRouter.post('/:id/ask', requireTripMember, askLimiter, validateBody(askSchema), async (req, res) => {
  const trip = req.trip;
  const [{ rows: [group] }, { rows: members }, proposals, { rows: privateInputs }] = await Promise.all([
    query('SELECT personality FROM groups WHERE id = $1', [trip.group_id]),
    query(
      `SELECT u.name, tm.status FROM trip_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.trip_id = $1 ORDER BY u.id`,
      [req.tripId],
    ),
    loadProposals(req.tripId),
    // PRIVATE: leakCheck only, never sent to the AI or returned.
    query(
      `SELECT u.name, pi.max_budget_cents, pi.preferences_text, pi.comfort_text
         FROM private_inputs pi JOIN users u ON u.id = pi.user_id
        WHERE pi.trip_id = $1`,
      [req.tripId],
    ),
  ]);

  const context = {
    trip: {
      title: trip.title,
      region: trip.region,
      startDate: trip.start_date,
      endDate: trip.end_date,
      nights: trip.nights,
      status: trip.status,
    },
    members: members.map((m) => ({ name: m.name, status: m.status })),
    proposals: proposals.map((p) => ({
      stay: p.listingName,
      area: p.area,
      perNight: usd(p.pricePerNightCents),
      total: usd(p.totalCents),
      amenities: p.amenities,
      why: p.reason,
      votes: p.voteCount,
    })),
  };

  try {
    const answer = await askPact({ context, question: req.body.question, personality: group.personality, privateInputs });
    res.json({ answer });
  } catch (err) {
    if (err instanceof AiError) return sendAiUnavailable(res, 'ask', err);
    throw err;
  }
});
