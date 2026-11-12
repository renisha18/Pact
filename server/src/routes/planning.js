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
import { filterListings, capsForListing } from '../lib/filterListings.js';
import { fairSplit } from '../lib/fairSplit.js';
import { counterfactual } from '../lib/counterfactual.js';
import {
  prepareNegotiations, saveNegotiations, negotiationNotice, WORKING_MESSAGE, EXHAUSTED_MESSAGE,
} from '../lib/negotiations.js';
import { chooseDates } from '../lib/dates.js';
import { proposalPublic } from '../lib/views.js';
import { extractAll, pickAndExplain } from '../ai/plan.js';
import { askPact } from '../ai/ask.js';
import { AiError } from '../ai/llm.js';

export const planningRouter = Router();
planningRouter.use(requireAuth);

const TOP_CANDIDATES = 8;
export const PLANNABLE_STATUSES = ['collecting', 'planning', 'voting'];
const NO_FIT_MESSAGE = 'No stay fits everyone right now. Try different dates or budgets.';
export const ALREADY_PLANNING_MESSAGE = 'Pact is already planning';
export const STALE_PLAN_MESSAGE = 'Plans changed while Pact was thinking — try again';
const CLAIM_SECONDS = 60;

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
       JOIN trips t ON t.id = p.trip_id AND t.active_version = p.plan_version
      WHERE p.trip_id = $1
      ORDER BY p.id`,
    [tripId],
  );
  return rows.map(proposalPublic);
}

// --- Planning (shared by POST /:id/plan and an accepted negotiation)

/**
 * PRIVATE: active consent overrides, userId -> [{listingId, kind, maxShareCents, roomType}].
 * Server-side only (filtering and share caps); never returned to any client.
 */
export async function loadOverrides(db, tripId) {
  const { rows } = await db.query(
    `SELECT user_id, listing_id, kind, accepted_max_share_cents, room_type
       FROM consent_overrides WHERE trip_id = $1 AND status = 'active' ORDER BY id`,
    [tripId],
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.user_id)) out.set(r.user_id, []);
    out.get(r.user_id).push({
      listingId: r.listing_id, kind: r.kind, maxShareCents: r.accepted_max_share_cents, roomType: r.room_type,
    });
  }
  return out;
}

export const RECHECK_MESSAGE = 'Plans need a quick re-check';

const nightsText = (n) => `${n} ${n === 1 ? 'night' : 'nights'}`;

/**
 * Claims a planning run: one atomic UPDATE bumps plan_version and stamps
 * planning_started_at, unless another run started in the last 60s.
 * @returns {Promise<number>} this run's plan_version
 */
async function claimPlan(tripId) {
  const { rows } = await query(
    `UPDATE trips SET plan_version = plan_version + 1, planning_started_at = now()
      WHERE id = $1 AND status = ANY($2)
        AND (planning_started_at IS NULL OR planning_started_at < now() - make_interval(secs => $3))
      RETURNING plan_version`,
    [tripId, PLANNABLE_STATUSES, CLAIM_SECONDS],
  );
  if (rows.length > 0) return rows[0].plan_version;
  const { rows: [t] } = await query('SELECT status FROM trips WHERE id = $1', [tripId]);
  if (!PLANNABLE_STATUSES.includes(t.status)) throw new HttpError(409, 'This trip can no longer be planned');
  throw new HttpError(409, ALREADY_PLANNING_MESSAGE);
}

/** Frees the claim if it's still ours. Changes nothing visible. */
function releaseClaim(db, tripId, version) {
  return db.query('UPDATE trips SET planning_started_at = NULL WHERE id = $1 AND plan_version = $2', [tripId, version]);
}

const STALE = Symbol('stale');

/**
 * The short save transaction. Locks the trip; writes only if this run still owns the
 * claim and nothing it read changed after it started (private input edits, negotiation
 * responses). On stale input it writes nothing, frees the claim and returns STALE.
 * All comparisons use planning_started_at inside SQL (full precision).
 */
async function saveRun(tripId, version, write) {
  return withTransaction(async (client) => {
    const { rows: [t] } = await client.query(
      'SELECT status, plan_version FROM trips WHERE id = $1 FOR UPDATE',
      [tripId],
    );
    if (t.plan_version !== version) throw new HttpError(409, ALREADY_PLANNING_MESSAGE);
    if (!PLANNABLE_STATUSES.includes(t.status)) {
      await releaseClaim(client, tripId, version);
      throw new HttpError(409, 'This trip can no longer be planned');
    }
    const { rows: [stale] } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM private_inputs WHERE trip_id = t.id AND updated_at > t.planning_started_at)
           OR EXISTS (SELECT 1 FROM negotiations WHERE trip_id = t.id AND responded_at > t.planning_started_at) AS stale
         FROM trips t WHERE t.id = $1`,
      [tripId],
    );
    if (stale.stale) {
      await releaseClaim(client, tripId, version);
      return STALE;
    }
    const out = await write(client, t);
    await releaseClaim(client, tripId, version);
    return out;
  });
}

/**
 * Runs the planner for a trip. Throws HttpError for 400/409 and AiError if the AI is down.
 * No DB transaction is held during AI calls. A failed run changes nothing visible:
 * the previous proposals and pending questions stay valid.
 * @returns {Promise<{status: string, proposals: object[], message?: string, planB?: {nights: number}}>}
 *   PUBLIC: safe to return to any trip member.
 */
export async function runPlan(tripId, actorUserId, { retryIfStale = true } = {}) {
  const version = await claimPlan(tripId);
  let result;
  try {
    result = await planRun(tripId, actorUserId, version);
  } catch (err) {
    await releaseClaim({ query }, tripId, version);
    throw err;
  }
  if (result !== STALE) return result;
  if (retryIfStale) return runPlan(tripId, actorUserId, { retryIfStale: false });
  throw new HttpError(409, STALE_PLAN_MESSAGE);
}

/**
 * Plain code, no AI. Everyone must have shared their days. The earliest run where all
 * members are free is saved as the trip's dates; otherwise returns { options } (counts only).
 */
async function resolveDates(trip, members) {
  const { rows } = await query(
    'SELECT user_id, day FROM member_availability WHERE trip_id = $1 ORDER BY day', [trip.id]);
  const availability = new Map(members.map((m) => [m.user_id, new Set()]));
  for (const r of rows) availability.get(r.user_id)?.add(r.day);
  const missing = [...availability.values()].filter((d) => d.size === 0).length;
  if (missing > 0) {
    throw new HttpError(400, `${missing} ${missing === 1 ? 'member still needs' : 'members still need'} to share their days`);
  }
  const result = chooseDates(trip.window_start, trip.window_end, trip.nights, availability);
  if (result.kind === 'fallback') return { options: result.options };
  await query(
    `UPDATE trips SET start_date = $2, end_date = $3, dates_status = 'chosen', date_options = NULL WHERE id = $1`,
    [trip.id, result.startDate, result.endDate],
  );
  return result;
}

async function planRun(tripId, actorUserId, version) {
  // Everything is read AFTER the claim, so any later change is caught by saveRun.
  const { rows: [trip] } = await query('SELECT * FROM trips WHERE id = $1', [tripId]);

  // PRIVATE rows: used for filtering and leakCheck only, never returned or sent to the AI.
  const { rows: members } = await query(
    `SELECT tm.trip_id, tm.user_id, u.name,
            pi.max_budget_cents, pi.preferences_text, pi.comfort_text
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

  if (trip.dates_status !== 'chosen') {
    const outcome = await resolveDates(trip, members);
    if (outcome.options) {
      // Nobody is named: only counts. The organizer picks, then plans again.
      return saveRun(tripId, version, async (client, t) => {
        await client.query('DELETE FROM proposals WHERE trip_id = $1', [tripId]); // votes cascade
        await client.query(`UPDATE negotiations SET status = 'expired' WHERE trip_id = $1 AND status = 'pending'`, [tripId]);
        await client.query(
          `UPDATE trips SET active_version = $2, chosen_listing_id = NULL, dates_status = 'pick', date_options = $3,
                  status = CASE WHEN status = 'voting' THEN 'planning' ELSE status END
            WHERE id = $1`,
          [tripId, version, JSON.stringify(outcome.options)],
        );
        await logEvent(client, tripId, actorUserId, 'dates_options', { count: outcome.options.length });
        return {
          status: t.status === 'voting' ? 'planning' : t.status,
          proposals: [],
          dateOptions: outcome.options,
          message: 'No dates work for everyone. The organizer picks from the closest windows.',
        };
      });
    }
    trip.start_date = outcome.startDate;
    trip.end_date = outcome.endDate;
  }

  const { rows: [group] } = await query('SELECT personality FROM groups WHERE id = $1', [trip.group_id]);
  const { rows: listings } = await query(
    `SELECT id, name, area, emoji, price_per_night_cents, max_guests, room_type,
            amenities, vibe_tags, description
       FROM listings WHERE region = $1 ORDER BY id`,
    [trip.region],
  );
  const listingsById = new Map(listings.map((l) => [l.id, l]));

  const extracted = await extractAll(members);
  const overrides = await loadOverrides({ query }, tripId);
  const filterMembers = members.map((m) => ({
    userId: m.user_id,
    capCents: m.max_budget_cents,
    extracted: extracted.get(m.user_id),
    overrides: overrides.get(m.user_id) ?? [],
  }));
  const candidates = filterListings(listings, filterMembers, trip.nights, members.length).slice(0, TOP_CANDIDATES);
  const picks = candidates.length > 0 ? await pickAndExplain(candidates, listingsById, group.personality, members) : [];

  if (picks.length === 0) {
    const options = counterfactual(listings, filterMembers, trip.nights, members.length);
    // AI messages are written here, outside any transaction.
    const result = await prepareNegotiations({ query }, tripId, options, {
      personality: group.personality, extracted, listingsById, privateInputs: members,
    });

    // Any no-fit outcome becomes the active plan: stale proposals leave the screen and,
    // if voting was open, the trip goes back to planning. Questions (if any) are saved too.
    return saveRun(tripId, version, async (client, t) => {
      if (result.outcome === 'negotiating') await saveNegotiations(client, tripId, version, result.asks);
      else await client.query(`UPDATE negotiations SET status = 'expired' WHERE trip_id = $1 AND status = 'pending'`, [tripId]);
      await client.query('DELETE FROM proposals WHERE trip_id = $1', [tripId]); // votes cascade
      await client.query(
        `UPDATE trips SET active_version = $2, chosen_listing_id = NULL,
                status = CASE WHEN status = 'voting' THEN 'planning' ELSE status END
          WHERE id = $1`,
        [tripId, version],
      );
      const status = t.status === 'voting' ? 'planning' : t.status;
      if (result.outcome === 'negotiating') {
        await logEvent(client, tripId, null, 'plan_negotiating');
        return { status, proposals: [], message: WORKING_MESSAGE };
      }
      if (result.outcome === 'plan_b') {
        await logEvent(client, tripId, actorUserId, 'plan_b', { nights: result.nights });
        return {
          status,
          proposals: [],
          planB: { nights: result.nights },
          message: `Plan B: no stay fits everyone for ${nightsText(trip.nights)}, but one does for ${nightsText(result.nights)}.`,
        };
      }
      if (result.outcome === 'exhausted') {
        await logEvent(client, tripId, null, 'negotiation_exhausted');
        return { status, proposals: [], message: EXHAUSTED_MESSAGE };
      }
      await logEvent(client, tripId, actorUserId, 'plan_no_fit');
      return { status, proposals: [], message: NO_FIT_MESSAGE };
    });
  }

  const totals = new Map(candidates.map((c) => [c.listingId, c.totalCents]));
  const saved = await saveRun(tripId, version, async (client) => {
    await client.query('DELETE FROM proposals WHERE trip_id = $1', [tripId]); // votes cascade
    for (const p of picks) {
      await client.query(
        'INSERT INTO proposals (trip_id, listing_id, total_cents, reason_text, plan_version) VALUES ($1, $2, $3, $4, $5)',
        [tripId, p.listingId, totals.get(p.listingId), p.reason, version],
      );
    }
    // A plan exists, so any open asks are moot.
    await client.query(`UPDATE negotiations SET status = 'expired' WHERE trip_id = $1 AND status = 'pending'`, [tripId]);
    await client.query(
      `UPDATE trips SET status = 'voting', chosen_listing_id = NULL, active_version = $2 WHERE id = $1`,
      [tripId, version],
    );
    await logEvent(client, tripId, actorUserId, 'plan', { proposalCount: picks.length });
    return true;
  });
  if (saved === STALE) return STALE;
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
  const { rows } = await query(
    `SELECT v.proposal_id FROM votes v
       JOIN proposals p ON p.id = v.proposal_id
       JOIN trips t ON t.id = p.trip_id AND t.active_version = p.plan_version
      WHERE v.trip_id = $1 AND v.user_id = $2`,
    [req.tripId, req.user.id],
  );
  // Public: which proposal won (null until voting completes).
  const { rows: winner } = await query(
    `SELECT p.id FROM proposals p
       JOIN trips t ON t.id = p.trip_id AND t.chosen_listing_id = p.listing_id AND t.active_version = p.plan_version
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

    const { rows: prop } = await client.query(
      `SELECT p.id FROM proposals p JOIN trips t ON t.id = p.trip_id AND t.active_version = p.plan_version
        WHERE p.id = $1 AND p.trip_id = $2`,
      [proposalId, req.tripId],
    );
    if (prop.length === 0) throw new HttpError(400, 'Unknown proposal');

    await client.query(
      `INSERT INTO votes (trip_id, user_id, proposal_id) VALUES ($1, $2, $3)
       ON CONFLICT (trip_id, user_id) DO UPDATE SET proposal_id = EXCLUDED.proposal_id`,
      [req.tripId, req.user.id, proposalId],
    );
    await logEvent(client, req.tripId, req.user.id, 'vote', { proposalId });

    // Everyone still on the trip has voted?
    const { rows: [counts] } = await client.query(
      `SELECT count(*) AS members, count(p.id) AS voted
         FROM trip_members tm
         JOIN trips t ON t.id = tm.trip_id
         LEFT JOIN votes v ON v.trip_id = tm.trip_id AND v.user_id = tm.user_id
         LEFT JOIN proposals p ON p.id = v.proposal_id AND p.plan_version = t.active_version
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
         FROM proposals p JOIN trips t ON t.id = p.trip_id AND t.active_version = p.plan_version
        WHERE p.trip_id = $1
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
    const overrides = await loadOverrides(client, req.tripId);
    const payers = caps.map((c) => ({
      userId: c.user_id, capCents: c.max_budget_cents, overrides: overrides.get(c.user_id) ?? [],
    }));

    for (const p of ranked) {
      // Caps for THIS listing: an override's accepted share where one exists, else the original budget.
      const split = fairSplit(p.total_cents, capsForListing(payers, p.listing_id));
      const consented = payers.flatMap((m) => m.overrides
        .filter((o) => o.listingId === p.listing_id && Number.isInteger(o.maxShareCents))
        .map((o) => ({ userId: m.userId, maxShareCents: o.maxShareCents })));
      const withinConsent = split.feasible && consented.every((o) =>
        split.shares.find((s) => s.userId === o.userId).amountCents <= o.maxShareCents);

      if (!withinConsent && consented.length > 0) {
        // The group picked a stay someone only agreed to at a price that no longer holds.
        // Store nothing; that consent is void and must be given afresh.
        await client.query('DELETE FROM shares WHERE trip_id = $1', [req.tripId]);
        await client.query(
          `UPDATE consent_overrides SET status = 'expired' WHERE trip_id = $1 AND listing_id = $2 AND status = 'active'`,
          [req.tripId, p.listing_id],
        );
        await client.query(`UPDATE trips SET status = 'planning', chosen_listing_id = NULL WHERE id = $1`, [req.tripId]);
        await logEvent(client, req.tripId, null, 'consent_recheck', { proposalId: p.id });
        return { status: 'planning', message: RECHECK_MESSAGE };
      }
      if (!split.feasible) continue;

      await client.query('DELETE FROM shares WHERE trip_id = $1', [req.tripId]);
      for (const s of split.shares) {
        await client.query('INSERT INTO shares (trip_id, user_id, amount_cents) VALUES ($1, $2, $3)', [
          req.tripId,
          s.userId,
          s.amountCents,
        ]);
      }
      // A different stay won: consent given for other stays no longer applies.
      await client.query(
        `UPDATE consent_overrides SET status = 'expired' WHERE trip_id = $1 AND listing_id <> $2 AND status = 'active'`,
        [req.tripId, p.listing_id],
      );
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
