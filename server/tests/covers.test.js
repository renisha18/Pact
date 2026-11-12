import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', async () => {
  const { createTestDb } = await import('./helpers/testDb.js');
  return createTestDb();
});
vi.mock('../src/paypal/orders.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    centsToUsd: real.centsToUsd,
    createAuthorizeOrder: vi.fn(), createCaptureOrder: vi.fn(), getOrder: vi.fn(), authorizeOrder: vi.fn(),
    captureOrder: vi.fn(), getAuthorization: vi.fn(), captureAuthorization: vi.fn(), voidAuthorization: vi.fn(),
    refundCapture: vi.fn(),
  };
});

const pp = await import('../src/paypal/orders.js');
const { __pg: pg } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const { repaymentPlan } = await import('../src/lib/repayment.js');

const as = (u) => `pact_session=${jwt.sign({ sub: String(u) }, process.env.JWT_SECRET)}`;
const [ANA, BEN, CLEO] = [1, 2, 3]; // Ana + Ben committed; Cleo needs more time
const SHARE = 10001; // not divisible by 3 -> checks installment cents
const NAMES = ['Ananame', 'Benname', 'Cleoname'];

beforeAll(async () => {
  await pg.exec(`
    INSERT INTO users (name, email) VALUES ('Ananame','a@x'), ('Benname','b@x'), ('Cleoname','c@x'), ('Outname','o@x');
    INSERT INTO groups (name, invite_token) VALUES ('G', 'tok');
    INSERT INTO group_members (group_id, user_id, role) VALUES (1,1,'organizer'), (1,2,'member'), (1,3,'member');
    INSERT INTO listings (name, area, price_per_night_cents, max_guests, room_type) VALUES ('Villa', 'Ubud', 15000, 4, 'private_rooms');
    INSERT INTO trips (group_id, title, start_date, end_date, nights, status, chosen_listing_id)
      VALUES (1, 'T1', '2027-01-01', '2027-01-03', 2, 'committing', 1);
    INSERT INTO trip_members (trip_id, user_id, status, commitment_type) VALUES
      (1,1,'committed','hold'), (1,2,'committed','hold'), (1,3,'submitted','need_time');
    INSERT INTO proposals (trip_id, listing_id, total_cents) VALUES (1, 1, ${SHARE * 3});
    INSERT INTO shares (trip_id, user_id, amount_cents) VALUES (1,1,${SHARE}), (1,2,${SHARE}), (1,3,${SHARE});
    INSERT INTO payments (trip_id, user_id, kind, amount_cents, status, paypal_authorization_id) VALUES
      (1,1,'hold',${SHARE},'authorized','AUTH-1'), (1,2,'hold',${SHARE},'authorized','AUTH-2');
  `);
});
beforeEach(() => vi.clearAllMocks());

const post = (path, u, body) => request(app).post(`/api/trips/1${path}`).set('Cookie', as(u)).send(body ?? {});
const get = (path, u) => request(app).get(`/api/trips/1${path}`).set('Cookie', as(u));
const hasNames = (body, names) => names.some((n) => JSON.stringify(body).includes(n));

describe('repaymentPlan', () => {
  it('splits into 1-3 installments summing to the amount, due after the trip', () => {
    for (const n of [1, 2, 3]) {
      const plan = repaymentPlan(SHARE, n, '2027-01-03');
      expect(plan).toHaveLength(n);
      expect(plan.reduce((s, i) => s + i.amountCents, 0)).toBe(SHARE);
      for (const i of plan) expect(i.dueDate > '2027-01-03').toBe(true);
    }
    expect(() => repaymentPlan(SHARE, 4, '2027-01-03')).toThrow();
  });
});

describe('cover = a private two-person match', () => {
  let offerId;

  it('step 1: an offer shows the coverer no name, and the group sees nothing', async () => {
    const res = await post('/cover/offer', ANA);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'offered', amountCents: SHARE });
    expect(hasNames(res.body, NAMES)).toBe(false);
    const mine = await get('/cover/mine', ANA);
    expect(mine.body).toEqual({ status: 'offered', amountCents: SHARE }); // still no name

    // The match is taken: Ben is not offered the same share, and sees nothing of it.
    expect((await get('/cover/available', BEN)).body).toEqual({ available: false, amountCents: null });
    expect((await get('/cover/offer', BEN)).body).toBeNull();
    expect((await get('/cover/mine', BEN)).body).toBeNull();
    // Group endpoints carry no cover details (member names in the roster are public, but not who covers whom).
    const roster = await get('', BEN);
    expect(JSON.stringify(roster.body)).not.toMatch(/cover|offer/i);
    expect(hasNames(await get('/readiness', BEN).then((r) => r.body), NAMES)).toBe(false);
  });

  it('step 2: only the member sees the coverer\'s name; no hold before they accept', async () => {
    const offer = (await get('/cover/offer', CLEO)).body;
    expect(offer).toMatchObject({ covererName: 'Ananame', amountCents: SHARE });
    expect(Object.keys(offer.plans)).toEqual(['1', '2', '3']);
    offerId = offer.id;

    // No PayPal order exists until Cleo agrees.
    expect((await post('/cover', ANA)).status).toBe(409);
    expect(pp.createAuthorizeOrder).not.toHaveBeenCalled();
    // Others can't answer Cleo's offer: plain 404.
    for (const u of [ANA, BEN]) {
      expect((await post(`/cover/offers/${offerId}`, u, { response: 'accept', installments: 1 })).status).toBe(404);
    }
  });

  it('decline reopens the offer to others (not to the same coverer)', async () => {
    expect((await post(`/cover/offers/${offerId}`, CLEO, { response: 'decline' })).body).toEqual({ response: 'decline' });
    expect((await get('/cover/available', ANA)).body.available).toBe(false); // Ana was declined
    expect((await get('/cover/available', BEN)).body).toEqual({ available: true, amountCents: SHARE });
    expect((await post('/cover/offer', BEN)).status).toBe(201);
    offerId = (await get('/cover/offer', CLEO)).body.id;
    expect((await get('/cover/offer', CLEO)).body.covererName).toBe('Benname');
  });

  it('step 3: after accept the coverer sees the name and approves the hold; the covers row appears only then', async () => {
    expect((await post(`/cover/offers/${offerId}`, CLEO, { response: 'accept', installments: 5 })).status).toBe(400);
    expect((await post(`/cover/offers/${offerId}`, CLEO, { response: 'accept', installments: 3 })).status).toBe(200);
    expect((await pg.query('SELECT 1 FROM covers')).rows).toHaveLength(0);

    expect((await get('/cover/mine', BEN)).body).toEqual({ status: 'accepted', amountCents: SHARE, coveredName: 'Cleoname' });
    expect((await get('/cover/mine', ANA)).body).toBeNull();

    pp.createAuthorizeOrder.mockResolvedValue({ id: 'ORD-COVER' });
    const start = await post('/cover', BEN);
    expect(start.status).toBe(201);
    expect(start.body).toEqual({ orderId: 'ORD-COVER', amountCents: SHARE });
    expect(pp.createAuthorizeOrder.mock.calls[0][0]).toBe(SHARE);
    expect((await pg.query('SELECT 1 FROM covers')).rows).toHaveLength(0); // hold not approved yet

    const pay = (await pg.query(`SELECT id FROM payments WHERE paypal_order_id = 'ORD-COVER'`)).rows[0];
    pp.getOrder.mockResolvedValue({ id: 'X', status: 'APPROVED', purchase_units: [{
      amount: { currency_code: 'USD', value: '100.01' }, custom_id: `pact-t1-p${pay.id}` }] });
    pp.authorizeOrder.mockResolvedValue({
      purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-COVER', status: 'CREATED', amount: { value: '100.01' } }] } }],
    });
    expect((await post('/cover/confirm', BEN, { orderId: 'ORD-COVER' })).status).toBe(200);

    const { rows: covers } = await pg.query('SELECT coverer_id, covered_id, amount_cents FROM covers');
    expect(covers).toEqual([{ coverer_id: BEN, covered_id: CLEO, amount_cents: SHARE }]);
    const { rows: plan } = await pg.query('SELECT n, amount_cents FROM cover_installments ORDER BY n');
    expect(plan.map((p) => p.amount_cents)).toEqual([3334, 3334, 3333]);
    // Everyone's share is now covered (counts only).
    expect((await get('/readiness', ANA)).body).toEqual({ secured: 3, total: 3, allSecured: true });
  });

  it('step 4: the tracker is visible only to the two parties, with names only for them', async () => {
    const ben = (await get('/cover/tracker', BEN)).body;
    const cleo = (await get('/cover/tracker', CLEO)).body;
    expect(ben[0]).toMatchObject({ role: 'coverer', counterpartName: 'Cleoname', amountCents: SHARE, repaidCents: 0 });
    expect(cleo[0]).toMatchObject({ role: 'covered', counterpartName: 'Benname', amountCents: SHARE, repaidCents: 0 });
    expect(cleo[0].nextDueDate).toBeTruthy();
    expect(cleo[0].installments).toHaveLength(3);

    // Everyone else (including the organizer) gets an empty tracker and no names anywhere.
    const ana = await get('/cover/tracker', ANA);
    expect(ana.body).toEqual([]);
    for (const res of [ana, await get('/readiness', ANA), await get('/cover/available', ANA)]) {
      expect(hasNames(res.body, ['Cleoname', 'Benname'])).toBe(false);
    }
    expect(hasNames((await get('/cover/mine', ANA)).body, NAMES)).toBe(false);
  });

  it('only the coverer can confirm a repayment; both trackers update', async () => {
    const first = (await get('/cover/tracker', BEN)).body[0].installments[0].id;
    for (const u of [ANA, CLEO]) expect((await post(`/cover/installments/${first}/received`, u)).status).toBe(404);
    expect((await post(`/cover/installments/${first}/received`, BEN)).status).toBe(200);
    for (const u of [BEN, CLEO]) {
      const t = (await get('/cover/tracker', u)).body[0];
      expect(t.repaidCents).toBe(3334);
      expect(t.installments[0].paid).toBe(true);
      expect(t.nextDueDate).toBe(t.installments[1].dueDate);
    }
    expect((await pg.query('SELECT repaid_cents FROM covers')).rows[0].repaid_cents).toBe(3334);
  });

  it('the member\'s bell shows "Repayment due" once a date passes, and nobody else\'s does', async () => {
    const kinds = async (u) => (await request(app).get('/api/me/actions').set('Cookie', as(u))).body.map((a) => a.kind);
    expect(await kinds(CLEO)).not.toContain('repayment_due');
    await pg.query(`UPDATE cover_installments SET due_date = '2000-01-01' WHERE n = 2`);
    const cleo = (await request(app).get('/api/me/actions').set('Cookie', as(CLEO))).body.find((a) => a.kind === 'repayment_due');
    expect(cleo.label).toBe('Repayment due — T1');
    expect(hasNames(cleo, NAMES)).toBe(false);
    for (const u of [ANA, BEN]) expect(await kinds(u)).not.toContain('repayment_due');
  });
});
