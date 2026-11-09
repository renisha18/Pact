// Commit, cover, book, leave, cancel. Every amount comes from the shares table
// (or a stored payments row), never from the client. PayPal is called only via
// ../paypal/orders.js. payments/shares/covers rows are PRIVATE to their owner.
import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { assertTripMember, parseId } from '../lib/membership.js';
import { paymentSelf } from '../lib/views.js';
import { PayPalError } from '../paypal/client.js';
import {
  centsToUsd, createAuthorizeOrder, createCaptureOrder, getOrder, authorizeOrder, captureOrder,
  captureAuthorization, voidAuthorization, refundCapture,
} from '../paypal/orders.js';

export const commitRouter = Router();
commitRouter.use(requireAuth);

const SECURED = ['authorized', 'captured', 'paid'];
const PENDING_TTL = "interval '30 minutes'"; // an unconfirmed order stops blocking others after this
const PLANS_CHANGED = 'Plans changed — Pact will re-plan.';

// --- middleware + helpers

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

function requireActiveMember(req, _res, next) {
  if (req.trip.member_status === 'dropped') throw new HttpError(409, "You've dropped out of this trip");
  next();
}

const moneyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (req) => `user:${req.user.id}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many payment requests, slow down' },
});

/** Only ids, kinds and statuses in details. Never amounts, names or private text. */
function logEvent(db, tripId, actorUserId, action, details = {}) {
  return db.query('INSERT INTO event_log (trip_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)', [
    tripId,
    actorUserId,
    action,
    JSON.stringify(details),
  ]);
}

function paypalFailed(err) {
  if (err instanceof PayPalError) return new HttpError(502, `PayPal couldn’t complete that (${err.issue})`);
  return err;
}

const customIdFor = (row) => `pact-t${row.trip_id}-p${row.id}`;

async function shareOf(tripId, userId) {
  const { rows } = await query(
    `SELECT s.amount_cents FROM shares s
       JOIN trip_members tm ON tm.trip_id = s.trip_id AND tm.user_id = s.user_id AND tm.status <> 'dropped'
      WHERE s.trip_id = $1 AND s.user_id = $2`,
    [tripId, userId],
  );
  return rows[0]?.amount_cents ?? null;
}

/** Is this user's own share already secured, or being secured by them or a friend? */
async function shareTaken(tripId, userId) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM payments WHERE trip_id = $1 AND user_id = $2 AND kind IN ('hold', 'payment')
                 AND status = ANY($3)) AS secured,
       EXISTS (SELECT 1 FROM covers WHERE trip_id = $1 AND covered_id = $2)
       OR EXISTS (SELECT 1 FROM payments WHERE trip_id = $1 AND covers_user_id = $2 AND kind = 'cover_hold'
                    AND (status = ANY($3) OR (status = 'created' AND created_at > now() - ${PENDING_TTL}))) AS covered`,
    [tripId, userId, SECURED],
  );
  return rows[0];
}

/**
 * Counts per member share. Private amounts stay server-side; callers expose only
 * secured/total/allSecured (+ an attention count).
 */
async function readiness(tripId) {
  const { rows: members } = await query(
    `SELECT s.user_id, s.amount_cents,
            (s.amount_cents = 0
             OR EXISTS (SELECT 1 FROM payments p WHERE p.trip_id = s.trip_id AND p.user_id = s.user_id
                          AND p.kind IN ('hold', 'payment') AND p.status = ANY($2))
             OR EXISTS (SELECT 1 FROM covers c WHERE c.trip_id = s.trip_id AND c.covered_id = s.user_id)) AS secured,
            EXISTS (SELECT 1 FROM payments p WHERE p.trip_id = s.trip_id
                      AND (p.user_id = s.user_id OR p.covers_user_id = s.user_id) AND p.status = 'failed') AS had_failure
       FROM shares s
       JOIN trip_members tm ON tm.trip_id = s.trip_id AND tm.user_id = s.user_id AND tm.status <> 'dropped'
      WHERE s.trip_id = $1`,
    [tripId, SECURED],
  );
  const { rows: [sums] } = await query(
    `SELECT COALESCE(sum(amount_cents), 0) AS secured_cents FROM payments
      WHERE trip_id = $1 AND kind IN ('hold', 'payment', 'cover_hold') AND status = ANY($2)`,
    [tripId, SECURED],
  );
  const { rows: [stay] } = await query(
    `SELECT p.total_cents FROM proposals p JOIN trips t ON t.id = p.trip_id AND t.chosen_listing_id = p.listing_id
      WHERE p.trip_id = $1 LIMIT 1`,
    [tripId],
  );
  const secured = members.filter((m) => m.secured).length;
  return {
    secured,
    total: members.length,
    allSecured: members.length > 0 && secured === members.length,
    needsAttention: members.filter((m) => !m.secured && m.had_failure).length,
    securedCents: Number(sums.secured_cents),
    shareSumCents: members.reduce((n, m) => n + m.amount_cents, 0),
    stayTotalCents: stay?.total_cents ?? null,
  };
}

const attentionMessage = (n) => `${n} ${n === 1 ? 'commitment needs' : 'commitments need'} attention`;

function canCommitNow(trip, hasFailed) {
  return trip.status === 'committing' || (trip.status === 'needs_attention' && hasFailed);
}

// --- order lifecycle shared by hold / payment / cover_hold

const KIND = {
  hold: { create: createAuthorizeOrder, done: 'authorized' },
  payment: { create: createCaptureOrder, done: 'paid' },
  cover_hold: { create: createAuthorizeOrder, done: 'authorized' },
};

/** Creates the PayPal order for an already-inserted payments row. Deletes the row if PayPal fails. */
async function openOrder(row) {
  try {
    const order = await KIND[row.kind].create(row.amount_cents, customIdFor(row), { requestId: `order-${row.id}` });
    if (typeof order?.id !== 'string') throw new PayPalError(502, 'NO_ORDER_ID');
    await query('UPDATE payments SET paypal_order_id = $2, updated_at = now() WHERE id = $1', [row.id, order.id]);
    await logEvent({ query }, row.trip_id, row.user_id, 'order_created', { paymentId: row.id, kind: row.kind });
    return order.id;
  } catch (err) {
    await query(`DELETE FROM payments WHERE id = $1 AND status = 'created'`, [row.id]);
    throw paypalFailed(err);
  }
}

async function startOwnOrder(req, kind) {
  const { tripId, user } = req;
  const { rows: failed } = await query(
    `SELECT 1 FROM payments WHERE trip_id = $1 AND user_id = $2 AND status = 'failed' LIMIT 1`,
    [tripId, user.id],
  );
  if (!canCommitNow(req.trip, failed.length > 0)) throw new HttpError(409, 'This trip isn’t taking commitments right now');

  const share = await shareOf(tripId, user.id);
  if (share === null) throw new HttpError(409, 'You don’t have a share on this trip');
  if (share === 0) throw new HttpError(409, 'Nothing to pay for your share');
  const taken = await shareTaken(tripId, user.id);
  if (taken.secured) throw new HttpError(409, 'Your share is already secured');
  if (taken.covered) throw new HttpError(409, 'A friend is already covering your share');

  // Re-use an open order of the same kind and amount (double click, page reload).
  const { rows: open } = await query(
    `SELECT id, paypal_order_id FROM payments
      WHERE trip_id = $1 AND user_id = $2 AND kind = $3 AND status = 'created' AND amount_cents = $4
        AND paypal_order_id IS NOT NULL AND created_at > now() - ${PENDING_TTL}
      ORDER BY id DESC LIMIT 1`,
    [tripId, user.id, kind, share],
  );
  if (open.length) return { orderId: open[0].paypal_order_id, amountCents: share };

  const { rows: [row] } = await query(
    `INSERT INTO payments (trip_id, user_id, kind, amount_cents, status) VALUES ($1, $2, $3, $4, 'created')
     RETURNING id, trip_id, user_id, kind, amount_cents`,
    [tripId, user.id, kind, share],
  );
  return { orderId: await openOrder(row), amountCents: share };
}

/** Checks the approved PayPal order against our stored row; returns nothing or throws 400. */
async function assertOrderMatches(row) {
  let order;
  try {
    order = await getOrder(row.paypal_order_id);
  } catch (err) {
    throw paypalFailed(err);
  }
  const pu = order?.purchase_units?.[0];
  const ok =
    order?.status === 'APPROVED' &&
    pu?.amount?.currency_code === 'USD' &&
    pu?.amount?.value === centsToUsd(row.amount_cents) &&
    pu?.custom_id === customIdFor(row);
  if (!ok) {
    await logEvent({ query }, row.trip_id, row.user_id, 'order_mismatch', { paymentId: row.id, kind: row.kind });
    throw new HttpError(400, order?.status !== 'APPROVED' ? 'This order hasn’t been approved yet' : 'Order amount does not match your share');
  }
}

/** Body-less money routes still reject any body fields (amounts never come from the client). */
const noBody = validateBody(z.strictObject({}));

const confirmSchema = z.strictObject({ orderId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });

async function confirmOrder(req, kind) {
  const { tripId, user } = req;
  // The order must be this user's, on this trip, of this kind. Otherwise: 404.
  const { rows } = await query(
    `SELECT id, trip_id, user_id, kind, amount_cents, status, paypal_order_id, covers_user_id
       FROM payments WHERE paypal_order_id = $1 AND trip_id = $2 AND user_id = $3 AND kind = $4`,
    [req.body.orderId, tripId, user.id, kind],
  );
  if (rows.length === 0) throw new HttpError(404, 'Not found');
  const row = rows[0];
  if (row.status === KIND[kind].done) return { status: row.status };
  if (row.status !== 'created') throw new HttpError(409, 'This order can’t be confirmed any more');

  // The share must still be the one this order was made for.
  const shareUserId = kind === 'cover_hold' ? row.covers_user_id : user.id;
  const share = shareUserId ? await shareOf(tripId, shareUserId) : null;
  if (share !== row.amount_cents) throw new HttpError(409, 'The shares changed. Start again.');
  if (kind === 'cover_hold') {
    const { rows: c } = await query('SELECT 1 FROM covers WHERE trip_id = $1 AND covered_id = $2', [tripId, shareUserId]);
    if (c.length) throw new HttpError(409, 'That share is already covered');
  }

  await assertOrderMatches(row);

  let update;
  try {
    if (kind === 'payment') {
      const res = await captureOrder(row.paypal_order_id, { requestId: `capture-order-${row.id}` });
      const cap = res?.purchase_units?.[0]?.payments?.captures?.[0];
      update = cap?.status === 'COMPLETED' && cap?.amount?.value === centsToUsd(row.amount_cents)
        ? { status: 'paid', captureId: cap.id }
        : { status: 'failed' };
    } else {
      const res = await authorizeOrder(row.paypal_order_id, { requestId: `authorize-${row.id}` });
      const auth = res?.purchase_units?.[0]?.payments?.authorizations?.[0];
      update = auth?.status === 'CREATED' && auth?.amount?.value === centsToUsd(row.amount_cents)
        ? { status: 'authorized', authorizationId: auth.id }
        : { status: 'failed' };
    }
  } catch (err) {
    await logEvent({ query }, tripId, user.id, 'confirm_failed', { paymentId: row.id, kind });
    throw paypalFailed(err);
  }

  await withTransaction(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE payments SET status = $2, paypal_authorization_id = COALESCE($3, paypal_authorization_id),
              paypal_capture_id = COALESCE($4, paypal_capture_id), updated_at = now()
        WHERE id = $1 AND status = 'created'`,
      [row.id, update.status, update.authorizationId ?? null, update.captureId ?? null],
    );
    if (rowCount === 0 || update.status === 'failed') return;
    if (kind === 'cover_hold') {
      await db.query('INSERT INTO covers (trip_id, coverer_id, covered_id, amount_cents) VALUES ($1, $2, $3, $4)', [
        tripId, user.id, row.covers_user_id, row.amount_cents,
      ]);
    } else {
      await db.query(`UPDATE trip_members SET status = 'committed' WHERE trip_id = $1 AND user_id = $2`, [tripId, user.id]);
    }
    await logEvent(db, tripId, user.id, `${kind}_${update.status}`, { paymentId: row.id });
  });
  if (update.status === 'failed') {
    await logEvent({ query }, tripId, user.id, 'confirm_failed', { paymentId: row.id, kind });
    throw new HttpError(402, 'PayPal didn’t complete that. Try again.');
  }
  return { status: update.status };
}

// --- routes: own hold / payment

commitRouter.post('/:id/commit/hold', requireTripMember, requireActiveMember, moneyLimiter, noBody, async (req, res) => {
  res.status(201).json(await startOwnOrder(req, 'hold'));
});
commitRouter.post('/:id/commit/hold/confirm', requireTripMember, requireActiveMember, moneyLimiter,
  validateBody(confirmSchema), async (req, res) => res.json(await confirmOrder(req, 'hold')));

commitRouter.post('/:id/commit/payment', requireTripMember, requireActiveMember, moneyLimiter, noBody, async (req, res) => {
  res.status(201).json(await startOwnOrder(req, 'payment'));
});
commitRouter.post('/:id/commit/payment/confirm', requireTripMember, requireActiveMember, moneyLimiter,
  validateBody(confirmSchema), async (req, res) => res.json(await confirmOrder(req, 'payment')));

/** PRIVATE: next need_time share nobody is securing (excluding the caller). Never return its user_id to a client. */
async function findUncovered(db, tripId, excludeUserId) {
  const { rows } = await db.query(
    `SELECT s.user_id, s.amount_cents FROM shares s
       JOIN trip_members tm ON tm.trip_id = s.trip_id AND tm.user_id = s.user_id
      WHERE s.trip_id = $1 AND s.user_id <> $2 AND s.amount_cents > 0
        AND tm.status <> 'dropped' AND tm.commitment_type = 'need_time'
        AND NOT EXISTS (SELECT 1 FROM covers c WHERE c.trip_id = s.trip_id AND c.covered_id = s.user_id)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.trip_id = s.trip_id
                          AND (p.user_id = s.user_id AND p.kind IN ('hold', 'payment')
                               OR p.covers_user_id = s.user_id AND p.kind = 'cover_hold')
                          AND (p.status = ANY($3) OR (p.status = 'created' AND p.created_at > now() - ${PENDING_TTL})))
      ORDER BY s.user_id LIMIT 1`,
    [tripId, excludeUserId, SECURED],
  );
  return rows;
}

// --- routes: cover a friend (never reveals whose share)

/** Amount only: is there a friend to cover right now? Only committed members see it. */
commitRouter.get('/:id/cover/available', requireTripMember, async (req, res) => {
  if (req.trip.member_status !== 'committed' || !['committing', 'needs_attention'].includes(req.trip.status)) {
    return res.json({ available: false, amountCents: null });
  }
  const open = await findUncovered({ query }, req.tripId, req.user.id);
  res.json({ available: open.length > 0, amountCents: open[0]?.amount_cents ?? null });
});

commitRouter.post('/:id/cover', requireTripMember, requireActiveMember, moneyLimiter, noBody, async (req, res) => {
  const { tripId, user } = req;
  if (!['committing', 'needs_attention'].includes(req.trip.status)) {
    throw new HttpError(409, 'This trip isn’t taking commitments right now');
  }
  if (req.trip.member_status !== 'committed') throw new HttpError(409, 'Commit your own share first');

  const { rows: mine } = await query(
    `SELECT id, paypal_order_id, amount_cents FROM payments
      WHERE trip_id = $1 AND user_id = $2 AND kind = 'cover_hold' AND status = 'created'
        AND paypal_order_id IS NOT NULL AND created_at > now() - ${PENDING_TTL}
      ORDER BY id DESC LIMIT 1`,
    [tripId, user.id],
  );
  if (mine.length) return res.status(201).json({ orderId: mine[0].paypal_order_id, amountCents: mine[0].amount_cents, coveringFor: 'a friend' });

  const row = await withTransaction(async (db) => {
    await db.query('SELECT id FROM trips WHERE id = $1 FOR UPDATE', [tripId]); // one claim at a time
    const open = await findUncovered(db, tripId, user.id);
    if (open.length === 0) return null;
    const { rows: [r] } = await db.query(
      `INSERT INTO payments (trip_id, user_id, kind, amount_cents, status, covers_user_id)
       VALUES ($1, $2, 'cover_hold', $3, 'created', $4)
       RETURNING id, trip_id, user_id, kind, amount_cents`,
      [tripId, user.id, open[0].amount_cents, open[0].user_id],
    );
    return r;
  });
  if (!row) throw new HttpError(409, 'Nobody needs covering right now. Thank you though!');

  // Response never includes the covered member's id or name.
  res.status(201).json({ orderId: await openOrder(row), amountCents: row.amount_cents, coveringFor: 'a friend' });
});

commitRouter.post('/:id/cover/confirm', requireTripMember, requireActiveMember, moneyLimiter,
  validateBody(confirmSchema), async (req, res) => {
    await confirmOrder(req, 'cover_hold');
    res.json({ status: 'authorized', message: 'You’re covering a friend. Thank you!' });
  });

// --- routes: readiness (public) + own status (private)

commitRouter.get('/:id/readiness', requireTripMember, async (req, res) => {
  const r = await readiness(req.tripId);
  res.json({
    secured: r.secured,
    total: r.total,
    allSecured: r.allSecured,
    ...(req.trip.status === 'needs_attention' && r.needsAttention > 0 ? { message: attentionMessage(r.needsAttention) } : {}),
  });
});

/** PRIVATE: the caller's own share, payments and any nudge. */
commitRouter.get('/:id/commit/me', requireTripMember, async (req, res) => {
  const { tripId, user } = req;
  const [share, taken, { rows: payments }, { rows: [tm] }] = await Promise.all([
    shareOf(tripId, user.id),
    shareTaken(tripId, user.id),
    query(
      `SELECT id, kind, amount_cents, status, paypal_order_id, updated_at FROM payments
        WHERE trip_id = $1 AND user_id = $2 ORDER BY id`,
      [tripId, user.id],
    ),
    query('SELECT commitment_type FROM trip_members WHERE trip_id = $1 AND user_id = $2', [tripId, user.id]),
  ]);
  const ownFailed = payments.some((p) => p.status === 'failed' && p.kind !== 'cover_hold');
  const coverFailed = payments.some((p) => p.status === 'failed' && p.kind === 'cover_hold')
    && !payments.some((p) => p.kind === 'cover_hold' && SECURED.includes(p.status));
  let nudge = null;
  if (ownFailed && !taken.secured && !taken.covered) nudge = 'Your hold didn’t go through. Please re-authorize your share.';
  else if (coverFailed) nudge = 'The hold you placed for a friend didn’t go through. You can try covering again.';
  res.json({
    shareCents: share,
    commitmentType: tm?.commitment_type ?? null,
    secured: taken.secured,
    coveredByFriend: taken.covered,
    payments: payments.map(paymentSelf),
    nudge,
  });
});

// --- routes: book (organizer)

async function captureWithRetry(p) {
  const opts = { requestId: `capture-${p.id}` }; // same id on retry → PayPal won't double-capture
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cap = await captureAuthorization(p.paypal_authorization_id, p.amount_cents, opts);
      if (cap?.status === 'COMPLETED' || cap?.status === 'PENDING') return { ok: true, captureId: cap.id };
    } catch {
      // fall through to retry; error details are not logged
    }
  }
  return { ok: false };
}

commitRouter.post('/:id/book', requireTripMember, requireOrganizer, moneyLimiter, noBody, async (req, res) => {
  const { tripId } = req;
  if (!['committing', 'needs_attention'].includes(req.trip.status)) throw new HttpError(409, 'This trip can’t be booked right now');

  const r = await readiness(tripId);
  if (!r.allSecured) throw new HttpError(409, 'Not everyone’s share is secured yet');
  if (r.stayTotalCents === null || r.securedCents !== r.stayTotalCents || r.shareSumCents !== r.stayTotalCents) {
    throw new HttpError(409, 'Secured amounts don’t add up to the stay total');
  }

  const { rows: toCapture } = await query(
    `SELECT id, user_id, kind, amount_cents, paypal_authorization_id, covers_user_id FROM payments
      WHERE trip_id = $1 AND status = 'authorized' ORDER BY id`,
    [tripId],
  );
  await logEvent({ query }, tripId, req.user.id, 'book_started', { captures: toCapture.length });

  let failed = 0;
  for (const p of toCapture) {
    const result = await captureWithRetry(p); // sequential on purpose
    await withTransaction(async (db) => {
      if (result.ok) {
        await db.query(
          `UPDATE payments SET status = 'captured', paypal_capture_id = $2, updated_at = now() WHERE id = $1`,
          [p.id, result.captureId ?? null],
        );
        await logEvent(db, tripId, null, 'capture_ok', { paymentId: p.id, kind: p.kind });
        return;
      }
      failed++;
      await db.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [p.id]);
      if (p.kind === 'cover_hold') {
        await db.query('DELETE FROM covers WHERE trip_id = $1 AND covered_id = $2', [tripId, p.covers_user_id]);
      } else {
        await db.query(`UPDATE trip_members SET status = 'submitted' WHERE trip_id = $1 AND user_id = $2`, [tripId, p.user_id]);
      }
      await logEvent(db, tripId, null, 'capture_failed', { paymentId: p.id, kind: p.kind });
    });
  }

  const status = failed > 0 ? 'needs_attention' : 'booked';
  await withTransaction(async (db) => {
    await db.query('UPDATE trips SET status = $2 WHERE id = $1', [tripId, status]);
    await logEvent(db, tripId, req.user.id, status === 'booked' ? 'booked' : 'book_needs_attention', { failed });
  });
  res.json(failed > 0 ? { status, message: attentionMessage(failed) } : { status });
});

// --- release money (leave + cancel)

/** Voids every authorized hold and refunds every capture on the trip. Never throws for PayPal errors. */
async function releaseAll(tripId, actorId, { refund }) {
  const { rows } = await query(
    `SELECT id, kind, status, paypal_authorization_id, paypal_capture_id FROM payments
      WHERE trip_id = $1 AND status IN ('created', 'authorized', 'captured', 'paid') ORDER BY id`,
    [tripId],
  );
  const result = { voided: 0, refunded: 0, failed: 0 };
  for (const p of rows) {
    let next = null;
    try {
      if (p.status === 'created') next = 'voided'; // never authorized: nothing to release at PayPal
      else if (p.status === 'authorized') {
        await voidAuthorization(p.paypal_authorization_id, { requestId: `void-${p.id}` });
        next = 'voided';
      } else if (refund && p.paypal_capture_id) {
        await refundCapture(p.paypal_capture_id, { requestId: `refund-${p.id}` });
        next = 'refunded';
      }
    } catch {
      result.failed++;
      await logEvent({ query }, tripId, actorId, 'release_failed', { paymentId: p.id, kind: p.kind });
      continue;
    }
    if (!next) continue;
    await query('UPDATE payments SET status = $2, updated_at = now() WHERE id = $1', [p.id, next]);
    if (p.status !== 'created') {
      result[next]++;
      await logEvent({ query }, tripId, actorId, next === 'voided' ? 'hold_voided' : 'refunded', { paymentId: p.id, kind: p.kind });
    }
  }
  return result;
}

commitRouter.post('/:id/leave', requireTripMember, requireActiveMember, moneyLimiter, noBody, async (req, res) => {
  const { tripId, user } = req;
  if (['booked', 'cancelled'].includes(req.trip.status)) throw new HttpError(409, 'This trip can’t be left any more');

  await withTransaction(async (db) => {
    await db.query(`UPDATE trip_members SET status = 'dropped' WHERE trip_id = $1 AND user_id = $2`, [tripId, user.id]);
    await logEvent(db, tripId, user.id, 'left');
  });

  // Shares change for everyone, so every hold is released and any early payment refunded.
  const released = await releaseAll(tripId, user.id, { refund: true });

  await withTransaction(async (db) => {
    await db.query('DELETE FROM shares WHERE trip_id = $1', [tripId]);
    await db.query('DELETE FROM covers WHERE trip_id = $1', [tripId]);
    await db.query(`UPDATE trip_members SET status = 'submitted' WHERE trip_id = $1 AND status = 'committed'`, [tripId]);
    await db.query(
      `UPDATE trips SET status = 'planning', chosen_listing_id = NULL
        WHERE id = $1 AND status IN ('voting', 'committing', 'needs_attention')`,
      [tripId],
    );
    await logEvent(db, tripId, user.id, 'replan_needed', released);
  });
  res.json({ status: 'dropped', message: PLANS_CHANGED });
});

// --- cancel (organizer)

commitRouter.post('/:id/cancel', requireTripMember, requireOrganizer, moneyLimiter, noBody, async (req, res) => {
  const { tripId } = req;
  // Already cancelled is allowed: re-running releases anything that failed last time.
  await query(`UPDATE trips SET status = 'cancelled' WHERE id = $1`, [tripId]); // stop new commits first
  const released = await releaseAll(tripId, req.user.id, { refund: true });
  await logEvent({ query }, tripId, req.user.id, 'cancelled', released);
  res.json({ status: 'cancelled', ...(released.failed ? { message: 'Some payments couldn’t be released yet. Try cancelling again in a minute.' } : {}) });
});
