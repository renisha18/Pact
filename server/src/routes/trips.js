import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { assertTripMember, parseId } from '../lib/membership.js';
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
  const { rows: [me] } = await query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [
    req.trip.group_id,
    req.user.id,
  ]);
  res.json({ trip: tripPublic(req.trip), members: rows.map(tripMemberPublic), myRole: me.role, myStatus: req.trip.member_status });
});

// --- Private input: every query is scoped to req.user.id; never by a client-supplied user id.

tripsRouter.get('/:id/private-input', requireTripMember, async (req, res) => {
  const { rows } = await query(
    `SELECT pi.max_budget_cents, pi.preferences_text, pi.comfort_text, pi.updated_at,
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
    preferencesText: z.string().trim().max(500).default(''),
    comfortText: z.string().trim().max(300).default(''),
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
      `INSERT INTO private_inputs (trip_id, user_id, max_budget_cents, preferences_text, comfort_text, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (trip_id, user_id) DO UPDATE
         SET max_budget_cents = EXCLUDED.max_budget_cents,
             preferences_text = EXCLUDED.preferences_text,
             comfort_text     = EXCLUDED.comfort_text,
             -- extracted_json is kept: each field's cache is keyed by its own text.
             updated_at       = now()
       RETURNING max_budget_cents, preferences_text, comfort_text, updated_at`,
      [req.tripId, userId, maxBudgetCents, preferencesText, comfortText],
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
