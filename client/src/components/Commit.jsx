// Commit stage UI: private commitment card, cover a friend, readiness, book,
// leave/cancel. PayPal results are never trusted on the client: after approval
// we tell the server, then re-read everything from the server.
import { useEffect, useRef, useState } from 'react';
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js';
import { api } from '../api.js';
import { useApi } from '../lib/useApi.js';
import { formatDate, formatUsd } from '../lib/format.js';
import { btn, card, ErrorNote, Loading } from './ui.jsx';
import { PixelLock, PactAvatar } from './Planning.jsx';

const PAYPAL_CLIENT_ID = import.meta.env.VITE_PAYPAL_CLIENT_ID;
// Only the PayPal-account option: no Pay Later, credit, card or Venmo buttons.
const DISABLED_FUNDING = 'paylater,credit,card,venmo';
const OPEN_STATUSES = new Set(['committing', 'needs_attention']);

const TYPE_LABEL = {
  hold: { emoji: '🔒', text: 'Hold now' },
  pay_by_date: { emoji: '📅', text: 'Pay by a date' },
  need_time: { emoji: '⏳', text: 'Need more time' },
};

// --- PayPal button (server creates + confirms; client only relays the order id)

function PayPalPay({ intent, createPath, confirmPath, onDone }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!PAYPAL_CLIENT_ID) {
    return <ErrorNote>PayPal isn’t set up yet (missing VITE_PAYPAL_CLIENT_ID).</ErrorNote>;
  }
  return (
    <div className="mt-4">
      {/* One provider per intent (authorize = holds, capture = pay now); the SDK intent must match the server order. key forces a fresh SDK script. */}
      <PayPalScriptProvider key={intent} options={{ clientId: PAYPAL_CLIENT_ID, currency: 'USD', intent, 'disable-funding': DISABLED_FUNDING }}>
        <div className={busy ? 'pointer-events-none opacity-60' : ''}>
          <PayPalButtons
            style={{ layout: 'vertical', shape: 'pill', label: intent === 'authorize' ? 'paypal' : 'pay', height: 44 }}
            fundingSource="paypal"
            createOrder={async () => {
              setError(null);
              try {
                const { orderId } = await api(createPath, { method: 'POST' });
                return orderId;
              } catch (err) {
                setError(err.message);
                throw err;
              }
            }}
            onApprove={async (data) => {
              setBusy(true);
              try {
                await api(confirmPath, { method: 'POST', body: { orderId: data.orderID } });
              } catch (err) {
                setError(err.message);
              } finally {
                setBusy(false);
                onDone(); // always refresh from the server, whatever happened
              }
            }}
            onCancel={() => setError('No worries. Nothing was held or charged.')}
            onError={() => setError((e) => e ?? 'PayPal hit a snag. Try again.')}
          />
        </div>
      </PayPalScriptProvider>
      {busy && <p className="mt-2 text-sm text-pine-soft" role="status">Checking with PayPal…</p>}
      <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>
    </div>
  );
}

// --- Confirm dialog

function ConfirmDialog({ open, title, body, confirmLabel, busy, onConfirm, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="confirm-title"
      className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl bg-cloud p-6 text-pine ring-1 ring-mint-dark backdrop:bg-pine/40">
      <h2 id="confirm-title" className="text-lg font-bold">{title}</h2>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-pine-soft">{body}</div>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn.base} ${btn.cloud} ${btn.small}`}>Never mind</button>
        <button type="button" disabled={busy} onClick={onConfirm} className={`${btn.base} ${btn.coral} ${btn.small}`}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

// --- Readiness

function ReadinessBar({ readiness }) {
  const { secured, total } = readiness;
  return (
    <section className={card} aria-labelledby="ready-title">
      <h2 id="ready-title" className="font-bold">{secured} of {total} commitments secured</h2>
      <div className="mt-3 flex gap-1" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={secured}
        aria-label="Commitments secured">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`h-3 flex-1 ${i < secured ? 'bg-coral' : 'bg-mint-dark'}`} />
        ))}
      </div>
      <p className="mt-3 text-sm text-pine-soft">
        {readiness.allSecured ? 'Everyone’s share is covered ✓' : 'Nobody has fronted the money.'}
      </p>
    </section>
  );
}

// --- My commitment (PRIVATE)

function statusLine(me, tripStatus) {
  const own = [...me.payments].reverse().find((p) => p.kind !== 'cover_hold' && p.status !== 'created');
  if (me.coveredByFriend) return { tone: 'ok', text: 'A friend will cover you ✓' };
  if (!own) return null;
  if (own.status === 'authorized') return { tone: 'ok', text: 'Funds authorized — not yet captured' };
  if (own.status === 'paid') return { tone: 'ok', text: 'Paid' };
  if (own.status === 'captured') {
    return { tone: 'ok', text: tripStatus === 'booked' ? 'Captured — booked' : 'Captured' };
  }
  if (own.status === 'voided') return { tone: 'muted', text: 'Hold released' };
  if (own.status === 'refunded') return { tone: 'muted', text: 'Refunded' };
  if (own.status === 'failed') return { tone: 'bad', text: 'Didn’t go through' };
  return null;
}

function MyCommitment({ tripId, tripStatus, me, onChanged }) {
  const type = TYPE_LABEL[me.commitmentType];
  const line = statusLine(me, tripStatus);
  const needsMoney = OPEN_STATUSES.has(tripStatus) && !me.secured && !me.coveredByFriend && me.shareCents > 0;
  const isRetry = tripStatus === 'needs_attention' && Boolean(me.nudge) && needsMoney;
  const canPayNow = needsMoney && (tripStatus === 'committing' || isRetry) && me.commitmentType !== 'need_time';
  const intent = me.commitmentType === 'pay_by_date' ? 'capture' : 'authorize';
  const kind = intent === 'capture' ? 'payment' : 'hold';
  const covers = me.payments.filter((p) => p.kind === 'cover_hold' && ['authorized', 'captured'].includes(p.status));

  return (
    <section className={card} aria-labelledby="mine-title">
      <h2 id="mine-title" className="flex items-center gap-2 font-bold"><PixelLock /> My commitment</h2>
      <p className="mt-1 text-xs text-pine-soft">Only you see this.</p>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-pine-soft">My share</p>
          <p className="text-3xl font-bold">{me.shareCents == null ? '—' : formatUsd(me.shareCents)}</p>
        </div>
        {type && (
          <span className="rounded-full bg-mint px-3 py-1 text-sm">
            <span aria-hidden="true">{type.emoji}</span> {type.text}
          </span>
        )}
      </div>

      {line && (
        <p className={`mt-4 rounded-xl px-3 py-2 text-sm font-medium ${
          line.tone === 'ok' ? 'bg-water/30' : line.tone === 'bad' ? 'bg-coral/10 text-coral-dark' : 'bg-mint text-pine-soft'
        }`} role="status">
          {line.text}
        </p>
      )}

      {me.nudge && (
        <div className="mt-4 flex items-start gap-2 rounded-xl bg-coral/10 px-3 py-2 text-sm text-coral-dark" role="alert">
          <PactAvatar className="h-5 w-5" /> <span>{me.nudge}</span>
        </div>
      )}

      {needsMoney && me.commitmentType === 'need_time' && (
        <p className="mt-4 rounded-xl bg-mint px-3 py-2 text-sm">
          Pact is looking for a friend to cover you. They’ll offer privately and you choose whether to accept. Nobody else will see it’s you.
        </p>
      )}

      {canPayNow && (
        <>
          <p className="mt-4 text-sm text-pine-soft">
            {intent === 'authorize'
              ? 'PayPal will say “Pay Now” — for a hold, your money is only reserved until the group books. You can be released anytime before booking.'
              : 'This pays your share now.'}
          </p>
          <PayPalPay intent={intent}
            createPath={`/api/trips/${tripId}/commit/${kind}`}
            confirmPath={`/api/trips/${tripId}/commit/${kind}/confirm`}
            onDone={onChanged} />
          {isRetry && <p className="mt-1 text-xs text-pine-soft">Retrying only affects your own share.</p>}
        </>
      )}

      {covers.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm">
          {covers.map((p) => (
            <li key={p.id} className="rounded-xl bg-mint px-3 py-2">
              Covering a friend: {formatUsd(p.amountCents)} ·{' '}
              {p.status === 'captured' ? (tripStatus === 'booked' ? 'Captured — booked' : 'Captured') : 'Funds authorized — not yet captured'}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Cover a friend: a private two-person match (names only ever shown to the two people involved)

function CoverFriend({ tripId, onChanged }) {
  const { data } = useApi(`/api/trips/${tripId}/cover/available`);
  const mine = useApi(`/api/trips/${tripId}/cover/mine`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function offer() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/trips/${tripId}/cover/offer`, { method: 'POST' });
      onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (mine.loading && !mine.data) return null;
  const open = mine.data;
  if (!open && !data?.available) return null;
  return (
    <section className={card} aria-labelledby="cover-title">
      {open?.status === 'accepted' ? (
        <>
          <h2 id="cover-title" className="font-bold">You’re covering {open.coveredName} — {formatUsd(open.amountCents)}</h2>
          <p className="mt-1 text-sm text-pine-soft">
            Approve the PayPal hold to finish. {open.coveredName} will repay you in installments after the trip.
          </p>
          <PayPalPay intent="authorize"
            createPath={`/api/trips/${tripId}/cover`}
            confirmPath={`/api/trips/${tripId}/cover/confirm`}
            onDone={onChanged} />
        </>
      ) : open ? (
        <>
          <h2 id="cover-title" className="font-bold">Offer sent</h2>
          <p className="mt-1 text-sm text-pine-soft">Waiting for them to respond. You’ll see their name once they accept.</p>
        </>
      ) : (
        <>
          <h2 id="cover-title" className="font-bold">A friend needs a {formatUsd(data.amountCents)} cover — offer to help?</h2>
          <p className="mt-1 text-sm text-pine-soft">
            They’ll be asked privately and can accept or decline. If they accept, they repay you in installments after the trip.
          </p>
          <button type="button" disabled={busy} onClick={offer} className={`${btn.base} ${btn.coral} ${btn.small} mt-4`}>
            {busy ? 'Sending…' : 'Offer to help'}
          </button>
          <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>
        </>
      )}
    </section>
  );
}

/** For the member being offered a cover (PRIVATE): accept with a repayment plan, or decline. */
function OfferForMe({ tripId, onChanged }) {
  const { data } = useApi(`/api/trips/${tripId}/cover/offer`);
  const [n, setN] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!data) return null;

  async function respond(body) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/trips/${tripId}/cover/offers/${data.id}`, { method: 'POST', body });
      onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const plan = data.plans[n];
  return (
    <section className={`${card} ring-2 ring-coral`} aria-labelledby="offer-title">
      <h2 id="offer-title" className="font-bold">
        {data.covererName} offered to cover your {formatUsd(data.amountCents)}.
      </h2>
      <p className="mt-1 text-sm text-pine-soft">You’ll repay {data.covererName} in installments after the trip. Only the two of you see this.</p>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium">How many installments?</legend>
        <div className="mt-2 flex gap-2">
          {[1, 2, 3].map((k) => (
            <label key={k} className="cursor-pointer">
              <input type="radio" name="installments" checked={n === k} onChange={() => setN(k)} className="peer sr-only" />
              <span className="block rounded-full bg-mint px-4 py-1.5 text-sm ring-1 ring-mint-dark peer-checked:bg-white peer-checked:ring-2 peer-checked:ring-coral">{k}</span>
            </label>
          ))}
        </div>
        <ul className="mt-3 space-y-1 text-sm">
          {plan.map((i) => <li key={i.n}>{formatUsd(i.amountCents)} · due {formatDate(i.dueDate, { month: 'short', day: 'numeric', year: 'numeric' })}</li>)}
        </ul>
      </fieldset>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy} onClick={() => respond({ response: 'accept', installments: n })} className={`${btn.base} ${btn.coral} ${btn.small}`}>Accept</button>
        <button type="button" disabled={busy} onClick={() => respond({ response: 'decline' })} className={`${btn.base} ${btn.cloud} ${btn.small}`}>Decline</button>
      </div>
      <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>
    </section>
  );
}

/** Repayment tracker, shown only to the coverer and the covered member. */
function RepaymentTracker({ tripId, onChanged }) {
  const { data } = useApi(`/api/trips/${tripId}/cover/tracker`);
  const [error, setError] = useState(null);
  if (!data?.length) return null;

  async function received(id) {
    setError(null);
    try {
      await api(`/api/trips/${tripId}/cover/installments/${id}/received`, { method: 'POST' });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      {data.map((t) => (
        <section key={`${t.role}-${t.counterpartName}`} className={card} aria-labelledby="repay-title">
          <h2 id="repay-title" className="flex items-center gap-2 font-bold"><PixelLock /> Repayment</h2>
          <p className="mt-1 text-sm text-pine-soft">
            {t.role === 'coverer' ? `You’re covering ${t.counterpartName}` : `${t.counterpartName} covered your share`} · {formatUsd(t.amountCents)}
          </p>
          <p className="mt-3 text-lg font-bold">Repaid {formatUsd(t.repaidCents)} of {formatUsd(t.amountCents)}</p>
          <p className="text-sm text-pine-soft">
            {t.nextDueDate ? `Next due ${formatDate(t.nextDueDate, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'All repaid ✓'}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {t.installments.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <span>{formatUsd(i.amountCents)} · {formatDate(i.dueDate, { month: 'short', day: 'numeric' })}</span>
                {i.paid ? <span className="rounded-full bg-water/30 px-2 py-0.5 text-xs">repaid ✓</span>
                  : t.role === 'coverer' && (
                    <button type="button" onClick={() => received(i.id)} className={`${btn.base} ${btn.cloud} ${btn.small}`}>Mark received</button>
                  )}
              </li>
            ))}
          </ul>
          <ErrorNote>{error}</ErrorNote>
        </section>
      ))}
    </>
  );
}

// --- Panel

export function CommitPanel({ trip, isOrganizer, onTripChanged, onNotice }) {
  const [rev, setRev] = useState(0);
  const refresh = () => {
    setRev((n) => n + 1);
    onTripChanged();
  };
  return <CommitPanelInner key={`${trip.status}-${rev}`} trip={trip} isOrganizer={isOrganizer} refresh={refresh} onNotice={onNotice} />;
}

function CommitPanelInner({ trip, isOrganizer, refresh, onNotice }) {
  const tripId = trip.id;
  const me = useApi(`/api/trips/${tripId}/commit/me`);
  const ready = useApi(`/api/trips/${tripId}/readiness`);
  const [dialog, setDialog] = useState(null); // 'leave' | 'cancel' | null
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function run(what, path) {
    setBusy(what);
    setError(null);
    try {
      const res = await api(path, { method: 'POST' });
      setDialog(null);
      onNotice(res?.message ?? null);
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  if ((me.loading && !me.data) || (ready.loading && !ready.data)) return <section className={card}><Loading /></section>;
  if (me.error || ready.error) return <ErrorNote>Couldn’t load commitments. Try refreshing.</ErrorNote>;

  const r = ready.data;
  const open = OPEN_STATUSES.has(trip.status);
  const canLeave = !['booked', 'cancelled'].includes(trip.status);
  const canCancel = isOrganizer && trip.status !== 'cancelled';

  return (
    <div className="space-y-4">
      {trip.status === 'needs_attention' && r.message && (
        <p className="rounded-2xl bg-coral/10 px-4 py-3 font-medium text-coral-dark ring-1 ring-coral" role="alert">
          ⚠️ {r.message}
        </p>
      )}
      {trip.status === 'booked' && (
        <p className="rounded-2xl bg-pine px-4 py-3 font-medium text-cloud">🎉 Booked! Everyone’s share has been captured.</p>
      )}

      {r.total > 0 && <ReadinessBar readiness={r} />}

      <div className="grid gap-4 md:grid-cols-2">
        <MyCommitment tripId={tripId} tripStatus={trip.status} me={me.data} onChanged={refresh} />
        {open && <OfferForMe tripId={tripId} onChanged={refresh} />}
        {open && <CoverFriend tripId={tripId} onChanged={refresh} />}
        <RepaymentTracker tripId={tripId} onChanged={refresh} />
      </div>

      {isOrganizer && open && (
        <section className={`${card} flex flex-wrap items-center justify-between gap-3`}>
          <p className="text-sm text-pine-soft">
            {r.allSecured ? 'Everyone’s secured. Booking captures every hold.' : 'Book now unlocks when every share is secured.'}
          </p>
          <button type="button" disabled={!r.allSecured || busy === 'book'} onClick={() => run('book', `/api/trips/${tripId}/book`)}
            className={`${btn.base} ${btn.coral}`}>
            {busy === 'book' ? 'Booking…' : 'Book now'}
          </button>
        </section>
      )}

      <ErrorNote>{!dialog && error}</ErrorNote>

      {(canLeave || canCancel) && (
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {canLeave && (
            <button type="button" onClick={() => { setError(null); setDialog('leave'); }} className={`${btn.base} ${btn.cloud} ${btn.small}`}>
              Leave trip
            </button>
          )}
          {canCancel && (
            <button type="button" onClick={() => { setError(null); setDialog('cancel'); }}
              className={`${btn.base} ${btn.small} text-coral-dark ring-1 ring-coral hover:bg-coral/10`}>
              Cancel trip
            </button>
          )}
        </div>
      )}

      <ConfirmDialog open={dialog === 'leave'} title="Leave this trip?" confirmLabel="Leave trip" busy={busy === 'leave'}
        onClose={() => setDialog(null)} onConfirm={() => run('leave', `/api/trips/${tripId}/leave`)}
        body={<>
          <p>Shares change when someone leaves, so Pact releases <strong>every</strong> PayPal hold on this trip (including yours) and refunds anything already paid.</p>
          <p>The group goes back to planning and Pact will re-plan. You can’t undo this.</p>
          <ErrorNote>{dialog === 'leave' && error}</ErrorNote>
        </>} />

      <ConfirmDialog open={dialog === 'cancel'} title="Cancel this trip?" confirmLabel="Cancel trip" busy={busy === 'cancel'}
        onClose={() => setDialog(null)} onConfirm={() => run('cancel', `/api/trips/${tripId}/cancel`)}
        body={<>
          <p>Pact releases every PayPal hold and refunds every payment, for everyone.</p>
          <p>The trip is cancelled for the whole group. You can’t undo this.</p>
          <ErrorNote>{dialog === 'cancel' && error}</ErrorNote>
        </>} />
    </div>
  );
}
