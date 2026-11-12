import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});

// PayPal is fully mocked; centsToUsd stays real.
vi.mock('../src/paypal/orders.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    centsToUsd: real.centsToUsd,
    createAuthorizeOrder: vi.fn(),
    createCaptureOrder: vi.fn(),
    getOrder: vi.fn(),
    authorizeOrder: vi.fn(),
    captureOrder: vi.fn(),
    getAuthorization: vi.fn(),
    captureAuthorization: vi.fn(),
    voidAuthorization: vi.fn(),
    refundCapture: vi.fn(),
  };
});

const pp = await import('../src/paypal/orders.js');
const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');

const as = (userId) => `pact_session=${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}`;
const A = 1; // organizer
const B = 2;
const C = 3;
const SHARE = 10000; // $100 each, stay total $300

beforeAll(async () => {
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Ana', 'a@x'), ('Ben', 'b@x'), ('Cleo', 'c@x');
    INSERT INTO groups (name, invite_token) VALUES ('G', 'tok');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1, 1, 'organizer'), (1, 2, 'member'), (1, 3, 'member');
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type) VALUES ('Villa', 'Ubud', 15000, 4, 'private_rooms');
  `);
});

beforeEach(() => vi.clearAllMocks());

let tripSeq = 0;
/** Fresh trip in 'committing' with three $100 shares. */
async function seedTrip({ cType = 'hold' } = {}) {
  const t = ++tripSeq;
  await pg.exec(`
    INSERT INTO trips (group_id, title, start_date, end_date, nights, status, chosen_listing_id)
      VALUES (1, 'T${t}', '2027-01-01', '2027-01-03', 2, 'committing', 1);
    INSERT INTO trip_members (trip_id, user_id, status, commitment_type) VALUES
      (${t}, 1, 'submitted', 'hold'), (${t}, 2, 'submitted', 'hold'), (${t}, 3, 'submitted', '${cType}');
    INSERT INTO proposals (trip_id, listing_id, total_cents) VALUES (${t}, 1, ${SHARE * 3});
    INSERT INTO shares (trip_id, user_id, amount_cents) VALUES (${t}, 1, ${SHARE}), (${t}, 2, ${SHARE}), (${t}, 3, ${SHARE});
  `);
  return t;
}

/** Inserts a payment row directly (already authorized/captured/paid). */
async function addPayment(trip, user, { kind = 'hold', status = 'authorized', auth = null, cap = null, covers = null } = {}) {
  const { rows } = await pg.query(
    `INSERT INTO payments (trip_id, user_id, kind, amount_cents, status, paypal_authorization_id, paypal_capture_id, covers_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [trip, user, kind, SHARE, status, auth, cap, covers],
  );
  if (kind !== 'cover_hold' && ['authorized', 'paid', 'captured'].includes(status)) {
    await pg.query(`UPDATE trip_members SET status = 'committed' WHERE trip_id = $1 AND user_id = $2`, [trip, user]);
  }
  if (kind === 'cover_hold') {
    await pg.query('INSERT INTO covers (trip_id, coverer_id, covered_id, amount_cents) VALUES ($1, $2, $3, $4)', [trip, user, covers, SHARE]);
  }
  return rows[0].id;
}

const approvedOrder = (value, customId) => ({
  id: 'X', status: 'APPROVED', purchase_units: [{ amount: { currency_code: 'USD', value }, custom_id: customId }],
});
const one = async (sql, params) => (await pg.query(sql, params)).rows[0];

describe('hold + confirm', () => {
  it('creates an order for the server-side share and confirms it', async () => {
    const t = await seedTrip();
    pp.createAuthorizeOrder.mockResolvedValue({ id: 'ORD-A1' });
    const sneaky = await request(app).post(`/api/trips/${t}/commit/hold`).set('Cookie', as(A)).send({ amountCents: 1 });
    expect(sneaky.status).toBe(400); // client amounts are rejected outright
    const start = await request(app).post(`/api/trips/${t}/commit/hold`).set('Cookie', as(A));
    expect(start.status).toBe(201);
    expect(start.body).toEqual({ orderId: 'ORD-A1', amountCents: SHARE });
    expect(pp.createAuthorizeOrder).toHaveBeenCalledTimes(1);
    expect(pp.createAuthorizeOrder.mock.calls[0][0]).toBe(SHARE);

    const pay = await one(`SELECT id FROM payments WHERE paypal_order_id = 'ORD-A1'`);
    pp.getOrder.mockResolvedValue(approvedOrder('100.00', `pact-t${t}-p${pay.id}`));
    pp.authorizeOrder.mockResolvedValue({
      purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-A1', status: 'CREATED', amount: { value: '100.00' } }] } }],
    });
    const ok = await request(app).post(`/api/trips/${t}/commit/hold/confirm`).set('Cookie', as(A)).send({ orderId: 'ORD-A1' });
    expect(ok.status).toBe(200);
    expect(await one('SELECT status, paypal_authorization_id FROM payments WHERE id = $1', [pay.id]))
      .toEqual({ status: 'authorized', paypal_authorization_id: 'AUTH-A1' });
    expect((await one('SELECT status FROM trip_members WHERE trip_id = $1 AND user_id = $2', [t, A])).status).toBe('committed');
  });

  it('rejects an approved order whose amount does not match the share', async () => {
    const t = await seedTrip();
    pp.createAuthorizeOrder.mockResolvedValue({ id: 'ORD-MISMATCH' });
    await request(app).post(`/api/trips/${t}/commit/hold`).set('Cookie', as(A));
    const pay = await one(`SELECT id FROM payments WHERE paypal_order_id = 'ORD-MISMATCH'`);
    pp.getOrder.mockResolvedValue(approvedOrder('1.00', `pact-t${t}-p${pay.id}`));

    const res = await request(app).post(`/api/trips/${t}/commit/hold/confirm`).set('Cookie', as(A)).send({ orderId: 'ORD-MISMATCH' });
    expect(res.status).toBe(400);
    expect(pp.authorizeOrder).not.toHaveBeenCalled();
    expect((await one('SELECT status FROM payments WHERE id = $1', [pay.id])).status).toBe('created');
  });

  it("user B can't confirm user A's order", async () => {
    const t = await seedTrip();
    pp.createAuthorizeOrder.mockResolvedValue({ id: 'ORD-A-ONLY' });
    await request(app).post(`/api/trips/${t}/commit/hold`).set('Cookie', as(A));

    const res = await request(app).post(`/api/trips/${t}/commit/hold/confirm`).set('Cookie', as(B)).send({ orderId: 'ORD-A-ONLY' });
    expect(res.status).toBe(404);
    expect(pp.getOrder).not.toHaveBeenCalled();
    expect(pp.authorizeOrder).not.toHaveBeenCalled();
  });
});

describe('cover', () => {
  it('shows an amount without revealing whose, and needs the member\'s agreement before any hold', async () => {
    const t = await seedTrip({ cType: 'need_time' });
    await addPayment(t, A, { auth: 'AUTH-CA' });
    const avail = await request(app).get(`/api/trips/${t}/cover/available`).set('Cookie', as(A));
    expect(avail.body).toEqual({ available: true, amountCents: SHARE });
    const notYou = await request(app).get(`/api/trips/${t}/cover/available`).set('Cookie', as(B)); // not committed
    expect(notYou.body).toEqual({ available: false, amountCents: null });
    // No offer accepted yet: no PayPal order can be created.
    const res = await request(app).post(`/api/trips/${t}/cover`).set('Cookie', as(A));
    expect(res.status).toBe(409);
    expect(pp.createAuthorizeOrder).not.toHaveBeenCalled();
  });
});

describe('readiness + book', () => {
  it('readiness is counts only', async () => {
    const t = await seedTrip();
    await addPayment(t, A, { auth: 'AUTH-R' });
    const res = await request(app).get(`/api/trips/${t}/readiness`).set('Cookie', as(B));
    expect(res.body).toEqual({ secured: 1, total: 3, allSecured: false });
  });

  it('one failed capture → needs_attention, other captures recorded, private nudge', async () => {
    const t = await seedTrip();
    const pA = await addPayment(t, A, { auth: 'AUTH-BA' });
    const pB = await addPayment(t, B, { auth: 'AUTH-BB' });
    const pC = await addPayment(t, C, { auth: 'AUTH-BC' });
    pp.captureAuthorization.mockImplementation(async (authId) => {
      if (authId === 'AUTH-BB') throw new Error('declined');
      return { id: `CAP-${authId}`, status: 'COMPLETED' };
    });

    const res = await request(app).post(`/api/trips/${t}/book`).set('Cookie', as(A));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'needs_attention', message: '1 commitment needs attention' });
    expect(pp.captureAuthorization.mock.calls.filter(([id]) => id === 'AUTH-BB')).toHaveLength(2); // one retry
    expect(pp.captureAuthorization.mock.calls.map(([, cents]) => cents)).toEqual([SHARE, SHARE, SHARE, SHARE]);

    const statuses = (await pg.query('SELECT id, status, paypal_capture_id FROM payments WHERE trip_id = $1 ORDER BY id', [t])).rows;
    expect(statuses).toEqual([
      { id: pA, status: 'captured', paypal_capture_id: 'CAP-AUTH-BA' },
      { id: pB, status: 'failed', paypal_capture_id: null },
      { id: pC, status: 'captured', paypal_capture_id: 'CAP-AUTH-BC' },
    ]);
    expect((await one('SELECT status FROM trips WHERE id = $1', [t])).status).toBe('needs_attention');

    const group = await request(app).get(`/api/trips/${t}/readiness`).set('Cookie', as(C));
    expect(group.body).toEqual({ secured: 2, total: 3, allSecured: false, message: '1 commitment needs attention' });
    const meB = await request(app).get(`/api/trips/${t}/commit/me`).set('Cookie', as(B));
    expect(meB.body.nudge).toMatch(/re-authorize/);
    const meC = await request(app).get(`/api/trips/${t}/commit/me`).set('Cookie', as(C));
    expect(meC.body.nudge).toBeNull();
  });

  it('all captures succeed → booked; non-organizer gets 403', async () => {
    const t = await seedTrip();
    for (const u of [A, B, C]) await addPayment(t, u, { auth: `AUTH-OK${u}` });
    pp.captureAuthorization.mockResolvedValue({ id: 'CAP', status: 'COMPLETED' });
    expect((await request(app).post(`/api/trips/${t}/book`).set('Cookie', as(B))).status).toBe(403);
    const res = await request(app).post(`/api/trips/${t}/book`).set('Cookie', as(A));
    expect(res.body).toEqual({ status: 'booked' });
  });

  it('refuses to book until every share is secured', async () => {
    const t = await seedTrip();
    await addPayment(t, A, { auth: 'AUTH-P1' });
    const res = await request(app).post(`/api/trips/${t}/book`).set('Cookie', as(A));
    expect(res.status).toBe(409);
    expect(pp.captureAuthorization).not.toHaveBeenCalled();
  });
});

describe('cancel + leave', () => {
  it('cancel voids holds and refunds captures', async () => {
    const t = await seedTrip();
    const hold = await addPayment(t, A, { auth: 'AUTH-X1' });
    const paid = await addPayment(t, B, { kind: 'payment', status: 'paid', cap: 'CAP-X2' });
    const captured = await addPayment(t, C, { status: 'captured', auth: 'AUTH-X3', cap: 'CAP-X3' });
    pp.voidAuthorization.mockResolvedValue(null);
    pp.refundCapture.mockResolvedValue({ id: 'R', status: 'COMPLETED' });

    const res = await request(app).post(`/api/trips/${t}/cancel`).set('Cookie', as(A));
    expect(res.body).toEqual({ status: 'cancelled' });
    expect(pp.voidAuthorization.mock.calls.map(([id]) => id)).toEqual(['AUTH-X1']);
    expect(pp.refundCapture.mock.calls.map(([id]) => id).sort()).toEqual(['CAP-X2', 'CAP-X3']);
    const rows = (await pg.query('SELECT id, status FROM payments WHERE trip_id = $1 ORDER BY id', [t])).rows;
    expect(rows).toEqual([
      { id: hold, status: 'voided' },
      { id: paid, status: 'refunded' },
      { id: captured, status: 'refunded' },
    ]);
    expect((await one('SELECT status FROM trips WHERE id = $1', [t])).status).toBe('cancelled');
  });

  it('leave voids ALL holds on the trip, clears shares, re-plans', async () => {
    const t = await seedTrip({ cType: 'need_time' });
    await addPayment(t, A, { auth: 'AUTH-L1' });
    await addPayment(t, B, { auth: 'AUTH-L2' });
    await addPayment(t, A, { kind: 'cover_hold', auth: 'AUTH-L3', covers: C });
    pp.voidAuthorization.mockResolvedValue(null);

    const res = await request(app).post(`/api/trips/${t}/leave`).set('Cookie', as(B));
    expect(res.body).toEqual({ status: 'dropped', message: 'Plans changed — Pact will re-plan.' });
    expect(pp.voidAuthorization.mock.calls.map(([id]) => id)).toEqual(['AUTH-L1', 'AUTH-L2', 'AUTH-L3']);
    expect((await pg.query(`SELECT 1 FROM payments WHERE trip_id = $1 AND status <> 'voided'`, [t])).rows).toHaveLength(0);
    expect((await pg.query('SELECT 1 FROM shares WHERE trip_id = $1', [t])).rows).toHaveLength(0);
    expect((await pg.query('SELECT 1 FROM covers WHERE trip_id = $1', [t])).rows).toHaveLength(0);
    expect((await one('SELECT status FROM trips WHERE id = $1', [t])).status).toBe('planning');
    expect((await one('SELECT status FROM trip_members WHERE trip_id = $1 AND user_id = $2', [t, B])).status).toBe('dropped');
    expect((await one('SELECT status FROM trip_members WHERE trip_id = $1 AND user_id = $2', [t, A])).status).toBe('submitted');
  });

  it('non-members get 404', async () => {
    await pg.exec(`INSERT INTO users (name, email) VALUES ('Out', 'o@x')`);
    const t = await seedTrip();
    const res = await request(app).post(`/api/trips/${t}/commit/hold`).set('Cookie', as(4));
    expect(res.status).toBe(404);
  });
});
