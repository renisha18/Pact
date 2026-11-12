import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { assertTripMember, parseId } from '../lib/membership.js';
import { loadVocabulary } from '../ai/extract.js';
import { validateChips } from '../lib/chips.js';
import { tripPublic, tripMemberPublic, privateInputSelf } from '../lib/views.js';

export const tripsRouter = Router();
tripsRouter.use(requireAuth);

// Membership is checked before any body validation so non-members always get a plain 404.
async function requireTripMember(req, _res, next) {
  req.tripId = parseId(req.params.id);
  req.trip = await assertTripMember(req.tripId, req.user.id);
  next();
}

tripsRouter.get('/:id', requireTripMember, async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.avatar_emoji, tm.status
       FROM trip_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.trip_id = $1
      ORDER BY u.id`,
    [req.tripId],
  );
  const { rows: [me] } = await query('SELECT gm.role, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.group_id = $1 AND gm.user_id = $2', [
    req.trip.group_id,
    req.user.id,
  ]);
  res.json({ trip: tripPublic(req.trip), members: rows.map(tripMemberPublic), myRole: me.role, groupName: me.name, myStatus: req.trip.member_status });
});

// --- Private input: every query is scoped to req.user.id; never by a client-supplied user id.

tripsRouter.get('/:id/private-input', requireTripMember, async (req, res) => {
  const { rows } = await query(
    `SELECT pi.max_budget_cents, pi.preferences_text, pi.comfort_text, pi.updated_at,
            pi.must_have_chips, pi.nice_to_have_chips,
            tm.commitment_type, tm.roast_level
       FROM private_inputs pi
       JOIN trip_members tm ON tm.trip_id = pi.trip_id AND tm.user_id = pi.user_id
      WHERE pi.trip_id = $1 AND pi.user_id = $2`,
    [req.tripId, req.user.id],
  );
  res.json(rows.length ? privateInputSelf(rows[0]) : null);
});

const privateInputSchema = z
  .strictObject({
    maxBudgetUsd: z.number().min(1).max(10000),
    // Free text ("Anything else?") is the only part that goes to AI extraction.
    preferencesText: z.string().trim().max(200).default(''),
    comfortText: z.string().trim().max(200).default(''),
    mustHaveChips: z.array(z.string().max(40)).max(30).default([]),
    niceToHaveChips: z.array(z.string().max(40)).max(40).default([]),
    commitmentType: z.enum(['hold', 'pay_by_date', 'need_time']),
    roastLevel: z.enum(['off', 'mild', 'savage']).default('mild'),
  })
  .transform((v, ctx) => {
    const cents = Math.round(v.maxBudgetUsd * 100);
    if (Math.abs(v.maxBudgetUsd * 100 - cents) > 1e-6) {
      ctx.addIssue({ code: 'custom', message: 'At most 2 decimal places', path: ['maxBudgetUsd'] });
      return z.NEVER;
    }
    const { maxBudgetUsd: _drop, ...rest } = v;
    return { ...rest, maxBudgetCents: cents };
  });

const EDITABLE_TRIP_STATUSES = new Set(['collecting', 'planning']);
const LOCKED_MEMBER_STATUSES = new Set(['committed', 'dropped']);

tripsRouter.put('/:id/private-input', requireTripMember, validateBody(privateInputSchema), async (req, res) => {
  const { maxBudgetCents, preferencesText, comfortText, commitmentType, roastLevel } = req.body;
  const mustHaveChips = [...new Set(req.body.mustHaveChips)];
  const niceToHaveChips = [...new Set(req.body.niceToHaveChips)];
  const chipError = validateChips(mustHaveChips, niceToHaveChips, await loadVocabulary());
  if (chipError) throw new HttpError(400, chipError);
  const userId = req.user.id;

  const row = await withTransaction(async (client) => {
    // Lock the trip so its status can't change underneath this write.
    const { rows: [trip] } = await client.query('SELECT status FROM trips WHERE id = $1 FOR UPDATE', [req.tripId]);
    if (!EDITABLE_TRIP_STATUSES.has(trip.status)) {
      throw new HttpError(409, 'Private inputs are locked for this trip');
    }
    const { rows: [member] } = await client.query(
      'SELECT status FROM trip_members WHERE trip_id = $1 AND user_id = $2 FOR UPDATE',
      [req.tripId, userId],
    );
    if (LOCKED_MEMBER_STATUSES.has(member.status)) {
      throw new HttpError(409, 'You can no longer change your input for this trip');
    }

    const { rows: [pi] } = await client.query(
      `INSERT INTO private_inputs (trip_id, user_id, max_budget_cents, preferences_text, comfort_text,
                                   must_have_chips, nice_to_have_chips, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (trip_id, user_id) DO UPDATE
         SET max_budget_cents = EXCLUDED.max_budget_cents,
             preferences_text = EXCLUDED.preferences_text,
             comfort_text     = EXCLUDED.comfort_text,
             must_have_chips  = EXCLUDED.must_have_chips,
             nice_to_have_chips = EXCLUDED.nice_to_have_chips,
             -- extracted_json is kept: each field's cache is keyed by its own text.
             updated_at       = now()
       RETURNING max_budget_cents, preferences_text, comfort_text, must_have_chips, nice_to_have_chips, updated_at`,
      [req.tripId, userId, maxBudgetCents, preferencesText, comfortText, mustHaveChips, niceToHaveChips],
    );
    // Consent was given against the old input: it no longer applies.
    await client.query(
      `UPDATE consent_overrides SET status = 'expired' WHERE trip_id = $1 AND user_id = $2 AND status = 'active'`,
      [req.tripId, userId],
    );
    // Any pending ask was computed from the old input: it no longer applies.
    await client.query(
      `UPDATE negotiations SET status = 'expired' WHERE trip_id = $1 AND user_id = $2 AND status = 'pending'`,
      [req.tripId, userId],
    );
    const { rows: [tm] } = await client.query(
      `UPDATE trip_members SET status = 'submitted', commitment_type = $3, roast_level = $4
        WHERE trip_id = $1 AND user_id = $2
        RETURNING commitment_type, roast_level`,
      [req.tripId, userId, commitmentType, roastLevel],
    );
    return { ...pi, ...tm };
  });

  res.json(privateInputSelf(row));
});
