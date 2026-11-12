import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/useApi.js';
import { useToast } from '../lib/toast.jsx';
import { formatRange } from '../lib/format.js';
import {
  Page, ErrorNote, NotFoundCard, Skeleton, TripStatusChip, Avatar, btn, card, input,
} from '../components/ui.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import PlanTripModal from '../components/PlanTripModal.jsx';

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

function TripCard({ trip, actionNeeded }) {
  return (
    <li>
      <Link to={`/trips/${trip.id}`}
        className="relative block h-full rounded-2xl bg-cloud p-5 shadow-sm ring-1 ring-mint-dark transition hover:-translate-y-0.5 hover:shadow">
        {actionNeeded && (
          <span className="absolute top-4 right-4 rounded-full bg-coral px-2.5 py-0.5 text-[11px] font-bold text-cloud">Action needed</span>
        )}
        <h3 className="truncate pr-24 font-bold">{trip.title}</h3>
        <p className="mt-1 text-sm text-pine-soft">{trip.startDate ? formatRange(trip.startDate, trip.endDate) : 'Dates: deciding…'}</p>
        <div className="mt-3"><TripStatusChip status={trip.status} /></div>
      </Link>
    </li>
  );
}

function GroupSkeleton() {
  return (
    <Page>
      <div className="flex items-center gap-4"><Skeleton className="h-16 w-16" /><Skeleton className="h-8 w-1/2" /></div>
      <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Skeleton className="h-48" /><Skeleton className="h-48" />
      </div>
    </Page>
  );
}

export default function Group() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const { state } = useLocation();
  const { data, error, loading } = useApi(`/api/groups/${encodeURIComponent(id)}`);
  const actions = useApi('/api/me/actions');
  const [planOpen, setPlanOpen] = useState(false);

  useEffect(() => {
    if (state?.toast) toast(state.toast);
  }, [state, toast]);

  if (loading) return <GroupSkeleton />;
  if (error) {
    return (
      <Page narrow>
        {error.status === 404 ? <NotFoundCard what="group" /> : <ErrorNote>{error.message}</ErrorNote>}
      </Page>
    );
  }

  const { group, members, trips, inviteUrl } = data;
  const isOrganizer = members.some((m) => m.id === user.id && m.role === 'organizer');
  const myTrips = new Set((actions.data ?? []).map((a) => a.tripId));

  return (
    <Page>
      <Breadcrumbs items={[{ label: 'Dashboard', to: '/dashboard' }, { label: group.name }]} />
      <Link to="/dashboard" className="mb-3 inline-block text-sm text-pine-soft hover:text-pine">← All groups</Link>
      <header className="flex items-center gap-4">
        <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-cloud text-4xl ring-1 ring-mint-dark" aria-hidden="true">
          {group.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold sm:text-3xl">{group.name}</h1>
          {group.description ? (
            <p className="mt-0.5 text-sm text-pine-soft">{group.description}</p>
          ) : isOrganizer ? (
            <Link to={`/groups/${group.id}/settings`} className="mt-0.5 inline-block text-sm text-pine-soft underline hover:text-pine">
              Add a description
            </Link>
          ) : null}
        </div>
        <Link
          to={`/groups/${group.id}/settings`}
          aria-label="Group settings"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-xl text-pine-soft hover:bg-mint-dark hover:text-pine"
        >
          <span aria-hidden="true">⚙️</span>
        </Link>
      </header>

      <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_18rem]">
        <section aria-labelledby="trips-title" className={trips.length === 0 ? 'rounded-2xl bg-white p-6 ring-2 ring-coral' : ''}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="trips-title" className="text-lg font-bold">Trips</h2>
            <button type="button" onClick={() => setPlanOpen(true)} className={`${btn.base} ${btn.coral} ${btn.small}`}>
              {trips.length === 0 ? '✨ Plan your first trip' : 'Plan a new trip'}
            </button>
          </div>
          {trips.length === 0 ? (
            <p className="text-sm text-pine-soft">No trips yet. Plan one and everyone gets invited to share their budget privately.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {trips.map((t) => <TripCard key={t.id} trip={t} actionNeeded={myTrips.has(t.id)} />)}
            </ul>
          )}
        </section>

        <div className="space-y-4">
          <InviteBox url={inviteUrl} />
          <section className={card} aria-labelledby="members-title">
            <h2 id="members-title" className="font-bold">Members · {members.length}</h2>
            <ul className="mt-3 space-y-3">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-3">
                  <Avatar emoji={m.avatarEmoji} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.name}{m.id === user.id ? ' (you)' : ''}</span>
                    <span className="block text-xs text-pine-soft">
                      {m.role === 'organizer' ? 'Organizer' : 'Member'}{m.funTitle ? ` · ${m.funTitle}` : ''}
                    </span>
                  </span>
                  <span className="rounded-full bg-water/30 px-2.5 py-0.5 text-xs font-medium">joined</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {planOpen && <PlanTripModal groupId={group.id} onClose={() => setPlanOpen(false)} />}
    </Page>
  );
}
