// Flexible dates. Availability is PRIVATE: every read/write is scoped to req.user.id,
// and no endpoint ever returns another member's days. Fallback options carry counts only.
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { assertTripMember, parseId } from '../lib/membership.js';
import { addDays, daysBetween, expandBlocks, windowDays } from '../lib/dates.js';

export const availabilityRouter = Router();
availabilityRouter.use(requireAuth);

async function requireTripMember(req, _res, next) {
  req.tripId = parseId(req.params.id);
  req.trip = await assertTripMember(req.tripId, req.user.id);
  next();
}

export const DATES_NUDGE = 'The chosen dates don’t match all the days you marked. You can still change your mind about joining.';

/** My own days + group-safe date state. */
availabilityRouter.get('/:id/availability', requireTripMember, async (req, res) => {
  const t = req.trip;
  const { rows } = await query(
    'SELECT start_day, end_day FROM availability_blocks WHERE trip_id = $1 AND user_id = $2 ORDER BY start_day',
    [req.tripId, req.user.id],
  );
  const blocks = rows.map((r) => ({ startDate: r.start_day, endDate: r.end_day }));
  const days = expandBlocks(blocks);
  const chosen = t.dates_status === 'chosen';
  const covered = chosen && t.window_start
    && windowDays(t.start_date, t.end_date).every((d) => days.has(d));
  res.json({
    windowStart: t.window_start ?? null,
    windowEnd: t.window_end ?? null,
    nights: t.nights,
    datesStatus: t.dates_status,
    blocks,
    submitted: blocks.length > 0,
    // PUBLIC counts only: never who is (un)available.
    options: t.dates_status === 'pick' ? t.date_options ?? [] : [],
    // PRIVATE nudge: only for a member the chosen dates don't fully suit.
    nudge: chosen && t.window_start && blocks.length > 0 && !covered ? DATES_NUDGE : null,
  });
});

const dayList = z.iso.date();
const blockSchema = z.strictObject({ startDate: dayList, endDate: dayList });
const availabilitySchema = z.strictObject({ blocks: z.array(blockSchema).min(1).max(60) });

const EDITABLE = new Set(['collecting', 'planning']);

availabilityRouter.put('/:id/availability', requireTripMember, validateBody(availabilitySchema), async (req, res) => {
  const t = req.trip;
  if (!t.window_start) throw new HttpError(409, 'This trip has fixed dates');
  // Every block is exactly as long as the trip and sits inside the window.
  const blocks = [...new Map(req.body.blocks.map((b) => [b.startDate, b])).values()]
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (const b of blocks) {
    if (daysBetween(b.startDate, b.endDate) !== t.nights) throw new HttpError(400, 'Each block must be as long as the trip');
    if (b.startDate < t.window_start || b.endDate > t.window_end) throw new HttpError(400, 'Pick blocks inside the date window');
  }

  await withTransaction(async (client) => {
    const { rows: [trip] } = await client.query(
      'SELECT status, dates_status FROM trips WHERE id = $1 FOR UPDATE', [req.tripId]);
    if (!EDITABLE.has(trip.status) || trip.dates_status === 'chosen') {
      throw new HttpError(409, 'Dates are already chosen');
    }
    if (req.trip.member_status === 'dropped') throw new HttpError(409, 'You can no longer change your days');
    await client.query('DELETE FROM availability_blocks WHERE trip_id = $1 AND user_id = $2', [req.tripId, req.user.id]);
    for (const b of blocks) {
      await client.query(
        'INSERT INTO availability_blocks (trip_id, user_id, start_day, end_day) VALUES ($1, $2, $3, $4)',
        [req.tripId, req.user.id, b.startDate, b.endDate],
      );
    }
    // Offered windows were counted from the old days: recompute on the next plan.
    if (trip.dates_status === 'pick') {
      await client.query(`UPDATE trips SET dates_status = 'deciding', date_options = NULL WHERE id = $1`, [req.tripId]);
    }
  });
  res.json({ blocks });
});

// --- Organizer picks one of the offered windows (counts-only fallback).

const pickSchema = z.strictObject({ startDate: dayList });

availabilityRouter.post('/:id/dates', requireTripMember, validateBody(pickSchema), async (req, res) => {
  const { rows } = await query(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND role = 'organizer'`,
    [req.trip.group_id, req.user.id],
  );
  if (rows.length === 0) throw new HttpError(403, 'Only the organizer can do that');

  const out = await withTransaction(async (client) => {
    const { rows: [t] } = await client.query(
      'SELECT status, dates_status, date_options, nights FROM trips WHERE id = $1 FOR UPDATE', [req.tripId]);
    if (t.dates_status !== 'pick') throw new HttpError(409, 'There are no dates to choose between right now');
    if (!EDITABLE.has(t.status)) throw new HttpError(409, 'Dates can no longer be changed');
    const option = (t.date_options ?? []).find((o) => o.startDate === req.body.startDate);
    if (!option) throw new HttpError(400, 'Pick one of the offered dates');
    await client.query(
      `UPDATE trips SET start_date = $2, end_date = $3, dates_status = 'chosen', date_options = NULL WHERE id = $1`,
      [req.tripId, option.startDate, addDays(option.startDate, t.nights)],
    );
    await client.query(
      'INSERT INTO event_log (trip_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.tripId, req.user.id, 'dates_chosen', JSON.stringify({ availableCount: option.availableCount, total: option.total })],
    );
    return { startDate: option.startDate, endDate: addDays(option.startDate, t.nights) };
  });
  res.json(out);
});
