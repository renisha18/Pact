// Cover a friend: a private two-person match. Names are returned ONLY to the two people involved;
// the group sees counts (routes/commit.js readiness). Every query is scoped to req.user.id.
//   1. a committed member offers (no name shown to them)  2. the need_time member accepts (choosing
//   1-3 installments) or declines (reopens)  3. the coverer approves the PayPal hold (commit.js)
//   4. the coverer marks installments received; both see the tracker.
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { assertTripMember, parseId } from '../lib/membership.js';
import { repaymentPlan, MAX_INSTALLMENTS } from '../lib/repayment.js';
import { findUncovered } from './commit.js';

export const coversRouter = Router();
coversRouter.use(requireAuth);

const OPEN = ['committing', 'needs_attention'];
const notFound = () => new HttpError(404, 'Not found');

async function requireTripMember(req, _res, next) {
  req.tripId = parseId(req.params.id);
  req.trip = await assertTripMember(req.tripId, req.user.id);
  next();
}

const noBody = validateBody(z.strictObject({}));

// --- 1. Offer (coverer). The response never names the member.

coversRouter.post('/:id/cover/offer', requireTripMember, noBody, async (req, res) => {
  const { tripId, user } = req;
  if (req.trip.member_status === 'dropped') throw new HttpError(409, "You've dropped out of this trip");
  if (!OPEN.includes(req.trip.status)) throw new HttpError(409, 'This trip isn’t taking commitments right now');
  if (req.trip.member_status !== 'committed') throw new HttpError(409, 'Commit your own share first');

  const offer = await withTransaction(async (db) => {
    await db.query('SELECT id FROM trips WHERE id = $1 FOR UPDATE', [tripId]); // one claim at a time
    const { rows: mine } = await db.query(
      `SELECT 1 FROM cover_offers WHERE trip_id = $1 AND coverer_id = $2 AND status IN ('offered', 'accepted')`,
      [tripId, user.id],
    );
    if (mine.length) throw new HttpError(409, 'You already have an open offer');
    const open = await findUncovered(db, tripId, user.id);
    if (open.length === 0) throw new HttpError(409, 'Nobody needs covering right now. Thank you though!');
    const { rows: [o] } = await db.query(
      `INSERT INTO cover_offers (trip_id, coverer_id, covered_id, amount_cents) VALUES ($1, $2, $3, $4)
       RETURNING id, amount_cents`,
      [tripId, user.id, open[0].user_id, open[0].amount_cents],
    );
    return o;
  });
  res.status(201).json({ status: 'offered', amountCents: offer.amount_cents });
});

// --- Coverer's own view of their open offer. The member's name appears only once they accept.

coversRouter.get('/:id/cover/mine', requireTripMember, async (req, res) => {
  const { rows } = await query(
    `SELECT o.status, o.amount_cents, u.name AS covered_name
       FROM cover_offers o JOIN users u ON u.id = o.covered_id
      WHERE o.trip_id = $1 AND o.coverer_id = $2 AND o.status IN ('offered', 'accepted')`,
    [req.tripId, req.user.id],
  );
  const o = rows[0];
  res.json(o ? {
    status: o.status,
    amountCents: o.amount_cents,
    ...(o.status === 'accepted' ? { coveredName: o.covered_name } : {}),
  } : null);
});

// --- 2. The member's view and answer

function plansFor(amountCents, endDate) {
  return Object.fromEntries(
    Array.from({ length: MAX_INSTALLMENTS }, (_, i) => [i + 1, repaymentPlan(amountCents, i + 1, endDate)]),
  );
}

coversRouter.get('/:id/cover/offer', requireTripMember, async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.amount_cents, u.name AS coverer_name
       FROM cover_offers o JOIN users u ON u.id = o.coverer_id
      WHERE o.trip_id = $1 AND o.covered_id = $2 AND o.status = 'offered'`,
    [req.tripId, req.user.id],
  );
  const o = rows[0];
  res.json(o ? {
    id: o.id,
    covererName: o.coverer_name,
    amountCents: o.amount_cents,
    plans: plansFor(o.amount_cents, req.trip.end_date),
  } : null);
});

const respondSchema = z.discriminatedUnion('response', [
  z.strictObject({ response: z.literal('accept'), installments: z.number().int().min(1).max(MAX_INSTALLMENTS) }),
  z.strictObject({ response: z.literal('decline') }),
]);

coversRouter.post('/:id/cover/offers/:oid', requireTripMember, validateBody(respondSchema), async (req, res) => {
  const oid = parseId(req.params.oid);
  const out = await withTransaction(async (db) => {
    await db.query('SELECT id FROM trips WHERE id = $1 FOR UPDATE', [req.tripId]);
    // Only the member this offer is for can answer; anyone else gets a plain 404.
    const { rows: [o] } = await db.query(
      `SELECT id, status FROM cover_offers WHERE id = $1 AND trip_id = $2 AND covered_id = $3 FOR UPDATE`,
      [oid, req.tripId, req.user.id],
    );
    if (!o) throw notFound();
    if (o.status !== 'offered' || !OPEN.includes(req.trip.status)) throw new HttpError(409, 'This offer is no longer open');
    if (req.body.response === 'decline') {
      await db.query(`UPDATE cover_offers SET status = 'declined', responded_at = now() WHERE id = $1`, [oid]);
      return { response: 'decline' };
    }
    await db.query(
      `UPDATE cover_offers SET status = 'accepted', installments = $2, responded_at = now() WHERE id = $1`,
      [oid, req.body.installments],
    );
    return { response: 'accept' };
  });
  res.json(out);
});

// --- 4. Tracker (only the two parties) + the coverer confirming a repayment

coversRouter.get('/:id/cover/tracker', requireTripMember, async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.amount_cents, o.coverer_id, o.covered_id, cu.name AS coverer_name, du.name AS covered_name,
            ci.id AS installment_id, ci.n, ci.amount_cents AS installment_cents, ci.due_date, ci.paid_at
       FROM cover_offers o
       JOIN users cu ON cu.id = o.coverer_id
       JOIN users du ON du.id = o.covered_id
       JOIN cover_installments ci ON ci.offer_id = o.id
      WHERE o.trip_id = $1 AND o.status = 'covered' AND (o.coverer_id = $2 OR o.covered_id = $2)
      ORDER BY o.id, ci.n`,
    [req.tripId, req.user.id],
  );
  const byOffer = new Map();
  for (const r of rows) {
    if (!byOffer.has(r.id)) {
      const iCover = r.coverer_id === req.user.id;
      byOffer.set(r.id, {
        role: iCover ? 'coverer' : 'covered',
        counterpartName: iCover ? r.covered_name : r.coverer_name,
        amountCents: r.amount_cents,
        repaidCents: 0,
        nextDueDate: null,
        installments: [],
      });
    }
    const t = byOffer.get(r.id);
    const paid = r.paid_at !== null;
    if (paid) t.repaidCents += r.installment_cents;
    else t.nextDueDate ??= r.due_date;
    t.installments.push({ id: r.installment_id, n: r.n, amountCents: r.installment_cents, dueDate: r.due_date, paid });
  }
  res.json([...byOffer.values()]);
});

coversRouter.post('/:id/cover/installments/:iid/received', requireTripMember, noBody, async (req, res) => {
  const iid = parseId(req.params.iid);
  await withTransaction(async (db) => {
    // Only the coverer of this trip's cover can confirm; anyone else gets a plain 404.
    const { rows: [i] } = await db.query(
      `SELECT ci.id, ci.paid_at, o.coverer_id, o.covered_id, o.id AS offer_id
         FROM cover_installments ci JOIN cover_offers o ON o.id = ci.offer_id
        WHERE ci.id = $1 AND o.trip_id = $2 AND o.coverer_id = $3 FOR UPDATE OF ci`,
      [iid, req.tripId, req.user.id],
    );
    if (!i) throw notFound();
    if (i.paid_at) return;
    await db.query('UPDATE cover_installments SET paid_at = now() WHERE id = $1', [iid]);
    await db.query(
      `UPDATE covers SET repaid_cents = (SELECT COALESCE(sum(amount_cents), 0) FROM cover_installments
                                          WHERE offer_id = $1 AND paid_at IS NOT NULL)
        WHERE trip_id = $2 AND coverer_id = $3 AND covered_id = $4`,
      [i.offer_id, req.tripId, i.coverer_id, i.covered_id],
    );
  });
  res.json({ ok: true });
});
