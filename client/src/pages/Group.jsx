import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api.js';
import { useApi } from '../lib/useApi.js';
import { formatRange, todayIso } from '../lib/format.js';
import {
  Page, Loading, ErrorNote, NotFoundCard, TripStatusChip, Avatar, btn, card, input, label,
} from '../components/ui.jsx';

const PERSONALITY_LABEL = { chill: 'Chill agent', wholesome: 'Wholesome agent', savage: 'Savage agent' };

function InviteBox({ url }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      ref.current?.select();
      document.execCommand?.('copy');
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className={card} aria-labelledby="invite-title">
      <h2 id="invite-title" className="font-bold">Invite friends</h2>
      <p className="mt-1 text-sm text-pine-soft">Anyone with this link can join the group.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          ref={ref}
          readOnly
          value={url}
          aria-label="Invite link"
          onFocus={(e) => e.target.select()}
          className={`${input} min-w-0 flex-1 text-sm`}
        />
        <button type="button" onClick={copy} className={`${btn.base} ${btn.coral} ${btn.small}`}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <span className="sr-only" aria-live="polite">{copied ? 'Invite link copied' : ''}</span>
    </section>
  );
}

function PlanTripForm({ groupId }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const today = todayIso();

  async function submit(e) {
    e.preventDefault();
    if (endDate <= startDate) return setError('End date must be after the start date.');
    setSaving(true);
    setError(null);
    try {
      const trip = await api(`/api/groups/${groupId}/trips`, {
        method: 'POST',
        body: { title: title.trim(), startDate, endDate },
      });
      navigate(`/trips/${trip.id}`);
    } catch (err) {
      setError(err.status === 400 ? 'Check the title and dates (trips are 1–60 nights).' : err.message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className={card} aria-labelledby="plan-title">
      <h2 id="plan-title" className="font-bold">Plan a trip</h2>
      <p className="mt-1 text-sm text-pine-soft">Everyone in the group gets invited to share their budget privately.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <div>
          <label htmlFor="trip-title" className={label}>Title</label>
          <input id="trip-title" className={input} value={title} onChange={(e) => setTitle(e.target.value)}
            maxLength={120} required placeholder="Bali, finally" />
        </div>
        <div>
          <label htmlFor="trip-start" className={label}>Start</label>
          <input id="trip-start" type="date" className={input} value={startDate} min={today}
            onChange={(e) => setStartDate(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="trip-end" className={label}>End</label>
          <input id="trip-end" type="date" className={input} value={endDate} min={startDate || today}
            onChange={(e) => setEndDate(e.target.value)} required />
        </div>
      </div>
      <div className="mt-4 space-y-3">
        <ErrorNote>{error}</ErrorNote>
        <button type="submit" disabled={saving} className={`${btn.base} ${btn.coral} ${btn.small}`}>
          {saving ? 'Creating…' : 'Start planning →'}
        </button>
      </div>
    </form>
  );
}

export default function Group() {
  const { id } = useParams();
  const { data, error, loading } = useApi(`/api/groups/${encodeURIComponent(id)}`);

  if (loading) return <Page><Loading /></Page>;
  if (error) {
    return (
      <Page narrow>
        {error.status === 404 ? <NotFoundCard what="group" /> : <ErrorNote>{error.message}</ErrorNote>}
      </Page>
    );
  }

  const { group, members, trips, inviteUrl } = data;

  return (
    <Page>
      <header className="flex items-center gap-4">
        <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-cloud text-4xl ring-1 ring-mint-dark" aria-hidden="true">
          {group.emoji}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold sm:text-3xl">{group.name}</h1>
          <p className="text-sm text-pine-soft">{PERSONALITY_LABEL[group.personality]}</p>
        </div>
      </header>

      <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <section className={card} aria-labelledby="trips-title">
            <h2 id="trips-title" className="font-bold">Trips</h2>
            {trips.length === 0 ? (
              <p className="mt-2 text-sm text-pine-soft">No trips yet. Plan one below.</p>
            ) : (
              <ul className="mt-3 divide-y divide-mint-dark">
                {trips.map((t) => (
                  <li key={t.id}>
                    <Link to={`/trips/${t.id}`} className="flex items-center justify-between gap-3 py-3 hover:text-coral-dark">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{t.title}</span>
                        <span className="block text-xs text-pine-soft">{formatRange(t.startDate, t.endDate)}</span>
                      </span>
                      <TripStatusChip status={t.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <PlanTripForm groupId={group.id} />
        </div>

        <div className="space-y-4">
          <InviteBox url={inviteUrl} />
          <section className={card} aria-labelledby="members-title">
            <h2 id="members-title" className="font-bold">Members · {members.length}</h2>
            <ul className="mt-3 space-y-3">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-3">
                  <Avatar emoji={m.avatarEmoji} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{m.name}</span>
                    <span className="block text-xs text-pine-soft">
                      {m.role === 'organizer' ? 'Organizer' : 'Member'}
                      {m.funTitle ? ` · ${m.funTitle}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </Page>
  );
}
