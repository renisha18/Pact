// Trip planning UI: plan trigger, proposals + voting, winner/share, Ask Pact chat.
// All amounts come from the server as integer cents; this file only formats them.
// User and AI text is rendered as plain text (React escapes it), never as HTML.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../lib/useApi.js';
import { formatUsd } from '../lib/format.js';
import { btn, card, input, ErrorNote, Loading } from './ui.jsx';

// --- Pixel art (original)

export function PixelLock({ className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 8 9" shapeRendering="crispEdges" className={`${className} shrink-0`} aria-hidden="true">
      <rect x="2" y="0" width="4" height="1" fill="var(--color-pine)" />
      <rect x="1" y="1" width="1" height="3" fill="var(--color-pine)" />
      <rect x="6" y="1" width="1" height="3" fill="var(--color-pine)" />
      <rect x="0" y="4" width="8" height="5" fill="var(--color-coral)" />
      <rect x="3" y="5" width="2" height="2" fill="var(--color-pine)" />
    </svg>
  );
}

/** Pact's mascot: a little round pixel sprout-blob. */
export function PactAvatar({ className = 'h-9 w-9' }) {
  return (
    <svg viewBox="0 0 10 10" shapeRendering="crispEdges" className={`${className} shrink-0`} aria-hidden="true">
      <rect x="5" y="0" width="1" height="2" fill="var(--color-pine)" />
      <rect x="6" y="0" width="2" height="1" fill="var(--color-water)" />
      <rect x="3" y="2" width="4" height="1" fill="var(--color-coral)" />
      <rect x="2" y="3" width="6" height="1" fill="var(--color-coral)" />
      <rect x="1" y="4" width="8" height="4" fill="var(--color-coral)" />
      <rect x="2" y="8" width="6" height="1" fill="var(--color-coral-dark)" />
      <rect x="3" y="5" width="1" height="1" fill="var(--color-pine)" />
      <rect x="6" y="5" width="1" height="1" fill="var(--color-pine)" />
      <rect x="4" y="7" width="2" height="1" fill="var(--color-cloud)" />
      <rect x="2" y="6" width="1" height="1" fill="#F2A09B" />
      <rect x="7" y="6" width="1" height="1" fill="#F2A09B" />
    </svg>
  );
}

/** Pixel cloud bumps that sit on top of a card. */
function CloudTop() {
  return (
    <svg viewBox="0 0 40 4" shapeRendering="crispEdges" preserveAspectRatio="none"
      className="absolute -top-3 left-0 h-4 w-full" aria-hidden="true">
      <g fill="var(--color-cloud)">
        <rect x="3" y="2" width="34" height="2" />
        <rect x="6" y="1" width="8" height="1" />
        <rect x="8" y="0" width="4" height="1" />
        <rect x="18" y="1" width="10" height="1" />
        <rect x="20" y="0" width="6" height="1" />
        <rect x="31" y="1" width="4" height="1" />
      </g>
    </svg>
  );
}

function SpeechBubble({ children, tone = 'mint' }) {
  const bg = tone === 'mint' ? 'bg-mint' : 'bg-white';
  return (
    <div className="flex items-start gap-2">
      <PactAvatar className="mt-1 h-7 w-7" />
      <div className={`relative min-w-0 flex-1 rounded-xl ${bg} px-3 py-2 text-sm leading-relaxed ring-1 ring-mint-dark`}>
        <span className={`absolute top-3 -left-1.5 h-3 w-3 rotate-45 ${bg} ring-1 ring-mint-dark [clip-path:polygon(0_0,0_100%,100%_100%)]`}
          aria-hidden="true" />
        <span className="sr-only">Pact says: </span>
        <p className="whitespace-pre-wrap break-words">{children}</p>
      </div>
    </div>
  );
}

// --- Planning trigger + loader

const PLANNING_LINES = [
  'Pact is reading the vibes…',
  'Counting pillows…',
  'Checking every budget (quietly)…',
  'Sniffing out pools and porches…',
  'Asking the map nicely…',
  'Shortlisting the cosiest spots…',
];

export function PlanningLoader() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % PLANNING_LINES.length), 1800);
    return () => clearInterval(t);
  }, []);
  return (
    <section className={`${card} flex flex-col items-center py-10 text-center`} role="status" aria-live="polite">
      <PactAvatar className="pixel-bob h-14 w-14" />
      <p className="mt-5 font-bold tracking-tight">
        {PLANNING_LINES[i]}
        <span className="pixel-caret ml-1 inline-block h-4 w-2 translate-y-0.5 bg-coral" aria-hidden="true" />
      </p>
      <div className="mt-4 flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n} className="pixel-dot h-2 w-2 bg-pine" style={{ animationDelay: `${n * 0.15}s` }} />
        ))}
      </div>
    </section>
  );
}

/** Shown while collecting/planning. Organizer gets the button once everyone has submitted. */
export function PlanPanel({ isOrganizer, waitingCount, planning, error, message, onPlan }) {
  if (planning) return <PlanningLoader />;
  const everyoneIn = waitingCount === 0;
  return (
    <section className={`${card} text-center`} aria-labelledby="plan-title">
      <h2 id="plan-title" className="sr-only">Plan the stay</h2>
      {everyoneIn && isOrganizer ? (
        <>
          <p className="text-sm text-pine-soft">Everyone’s shared. Ready when you are.</p>
          <button type="button" onClick={onPlan} className={`${btn.base} ${btn.coral} mt-4`}>Plan with Pact ✨</button>
        </>
      ) : everyoneIn ? (
        <p className="font-medium">Everyone’s in! Waiting for the organizer to plan.</p>
      ) : (
        <p className="font-medium">
          Waiting for {waitingCount} more {waitingCount === 1 ? 'friend' : 'friends'}
          <span className="pixel-caret ml-1 inline-block h-3 w-1.5 bg-coral" aria-hidden="true" />
        </p>
      )}
      <div className="mt-4 space-y-3 text-left">
        {message && <SpeechBubble>{message}</SpeechBubble>}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </section>
  );
}

// --- Proposals + voting

function ProposalCard({ p, isMine, canVote, voting, onVote, winner = false }) {
  const amenities = Array.isArray(p.amenities) ? p.amenities : [];
  return (
    <article className={`relative mt-3 flex flex-col rounded-[1.75rem] bg-cloud p-5 pt-6 ring-1 ${winner ? 'ring-2 ring-coral' : 'ring-mint-dark'}`}
      aria-label={p.listingName}>
      <CloudTop />
      <div className="flex items-start gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-mint text-2xl" aria-hidden="true">{p.emoji}</span>
        <div className="min-w-0">
          <h3 className="font-bold leading-snug break-words">{p.listingName}</h3>
          <p className="text-xs text-pine-soft">{p.area}</p>
        </div>
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-2">
        <p className="text-xl font-bold">{formatUsd(p.totalCents)}<span className="ml-1 text-xs font-normal text-pine-soft">total</span></p>
        <p className="text-xs text-pine-soft">{formatUsd(p.pricePerNightCents)}/night</p>
      </div>

      {amenities.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Amenities">
          {amenities.map((a) => (
            <li key={a} className="rounded-full bg-mint px-2.5 py-0.5 text-xs">{a}</li>
          ))}
        </ul>
      )}

      {p.reason && <div className="mt-4"><SpeechBubble>{p.reason}</SpeechBubble></div>}

      <div className="mt-auto flex items-center justify-between gap-3 pt-5">
        <span className="text-sm text-pine-soft" aria-label={`${p.voteCount} votes`}>
          🗳️ {p.voteCount} {p.voteCount === 1 ? 'vote' : 'votes'}
        </span>
        {canVote && (
          isMine ? (
            <span className="rounded-full bg-pine px-4 py-2 text-sm text-cloud">Your vote ✓</span>
          ) : (
            <button type="button" disabled={voting} onClick={() => onVote(p.id)}
              className={`${btn.base} ${btn.coral} ${btn.small}`}>
              Vote
            </button>
          )
        )}
      </div>
    </article>
  );
}

function MyShareCard({ tripId }) {
  const { data, error, loading } = useApi(`/api/trips/${tripId}/my-share`);
  if (loading) return <section className={card}><Loading /></section>;
  if (error || !data) return null;
  return (
    <section className={`${card} self-start`} aria-labelledby="share-title">
      <h3 id="share-title" className="flex items-center gap-2 font-bold"><PixelLock /> Your share</h3>
      <p className="mt-3 text-3xl font-bold">{formatUsd(data.amountCents)}</p>
      <p className="mt-1 text-xs text-pine-soft">of {formatUsd(data.totalCents)} total</p>
      <p className="mt-4 flex items-center gap-2 rounded-xl bg-mint px-3 py-2 text-xs text-pine-soft">
        <PixelLock className="h-3 w-3" /> Only you see this.
      </p>
    </section>
  );
}

/** Proposals while voting; winner + private share once voting is done. */
export function Proposals({ tripId, tripStatus, canVote, isOrganizer, onChanged, onReplan }) {
  const { data, error, loading, reload } = useApi(`/api/trips/${tripId}/proposals`);
  const [voting, setVoting] = useState(false);
  const [voteError, setVoteError] = useState(null);
  const [notice, setNotice] = useState(null);

  // Re-fetch when the trip status changes (e.g. re-plan or voting completes).
  const prevStatus = useRef(tripStatus);
  useEffect(() => {
    if (prevStatus.current !== tripStatus) reload();
    prevStatus.current = tripStatus;
  }, [tripStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  async function vote(proposalId) {
    setVoting(true);
    setVoteError(null);
    try {
      const res = await api(`/api/trips/${tripId}/votes`, { method: 'POST', body: { proposalId } });
      setNotice(res.message ?? null);
      await reload();
      if (res.status !== tripStatus) onChanged();
    } catch (err) {
      setVoteError(err.message);
    } finally {
      setVoting(false);
    }
  }

  if (loading && !data) return <section className={card}><Loading /></section>;
  if (error) return <ErrorNote>Couldn’t load the proposals.</ErrorNote>;
  const proposals = data?.proposals ?? [];
  if (proposals.length === 0) return null;

  const winner = data.winningProposalId ? proposals.find((p) => p.id === data.winningProposalId) : null;
  if (winner) {
    return (
      <section aria-labelledby="winner-title">
        <h2 id="winner-title" className="text-lg font-bold">🎉 The group picked</h2>
        <div className="mt-2 grid gap-4 md:grid-cols-[1fr_16rem]">
          <ProposalCard p={winner} winner canVote={false} />
          <div className="md:mt-3"><MyShareCard tripId={tripId} /></div>
        </div>
      </section>
    );
  }

  const open = tripStatus === 'voting';
  return (
    <section aria-labelledby="proposals-title">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="proposals-title" className="text-lg font-bold">Pact’s picks</h2>
          <p className="text-sm text-pine-soft">
            {open ? (data.myVoteProposalId ? 'You can change your vote until everyone’s in.' : 'Vote for your favourite.') : 'Voting is closed.'}
          </p>
        </div>
        {open && isOrganizer && (
          <button type="button" onClick={onReplan} className={`${btn.base} ${btn.cloud} ${btn.small}`}>Re-plan ✨</button>
        )}
      </div>
      <div className="mt-2 grid gap-4 md:grid-cols-3">
        {proposals.map((p) => (
          <ProposalCard key={p.id} p={p} isMine={data.myVoteProposalId === p.id}
            canVote={open && canVote} voting={voting} onVote={vote} />
        ))}
      </div>
      <div className="mt-4 space-y-3">
        {notice && <SpeechBubble tone="white">{notice}</SpeechBubble>}
        <ErrorNote>{voteError}</ErrorNote>
      </div>
    </section>
  );
}

// --- Ask Pact (session-only, last 5 exchanges, nothing stored)

const MAX_EXCHANGES = 5;

export function AskPact({ tripId }) {
  const [question, setQuestion] = useState('');
  const [log, setLog] = useState([]); // [{ id, q, a, pending, error }]
  const nextId = useRef(1);
  const busy = log.some((e) => e.pending);

  async function ask(e) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    const id = nextId.current++;
    setQuestion('');
    setLog((l) => [...l, { id, q, pending: true }].slice(-MAX_EXCHANGES));
    let patch;
    try {
      const res = await api(`/api/trips/${tripId}/ask`, { method: 'POST', body: { question: q } });
      patch = { a: res.answer };
    } catch (err) {
      patch = { error: err.status === 429 ? 'Whoa, lots of questions! Give Pact a minute.' : err.message };
    }
    setLog((l) => l.map((x) => (x.id === id ? { ...x, ...patch, pending: false } : x)));
  }

  return (
    <section className={card} aria-labelledby="ask-title">
      <h2 id="ask-title" className="flex items-center gap-2 font-bold"><PactAvatar className="h-6 w-6" /> Ask Pact</h2>
      <p className="mt-1 text-xs text-pine-soft">Questions about this trip. Pact never shares anyone’s private details.</p>

      {log.length > 0 && (
        <ol className="mt-4 space-y-4" aria-live="polite">
          {log.map((x) => (
            <li key={x.id} className="space-y-2">
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-xl bg-coral px-3 py-2 text-sm whitespace-pre-wrap break-words text-cloud">
                  <span className="sr-only">You asked: </span>{x.q}
                </p>
              </div>
              {x.pending ? (
                <SpeechBubble>Thinking<span className="pixel-caret ml-1 inline-block h-3 w-1.5 bg-coral" aria-hidden="true" /></SpeechBubble>
              ) : x.error ? (
                <ErrorNote>{x.error}</ErrorNote>
              ) : (
                <SpeechBubble>{x.a}</SpeechBubble>
              )}
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={ask} className="mt-4 flex gap-2">
        <label htmlFor="ask-input" className="sr-only">Ask Pact a question</label>
        <input id="ask-input" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={200}
          className={input} placeholder="Which stay is closest to the beach?" autoComplete="off" />
        <button type="submit" disabled={busy || !question.trim()} className={`${btn.base} ${btn.coral} ${btn.small} shrink-0`}>
          Ask
        </button>
      </form>
    </section>
  );
}
