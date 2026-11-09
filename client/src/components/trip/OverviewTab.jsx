import { Avatar, Skeleton, btn, card } from '../ui.jsx';
import { useApi } from '../../lib/useApi.js';
import { ACTION_TAB, COMMIT_STAGE, EDITABLE_TRIP, activeMembers, buildStages } from '../../lib/tripState.js';

const MEMBER_CHIP = {
  invited: { cls: 'bg-mint-dark/60 text-pine-soft', text: 'invited' },
  submitted: { cls: 'bg-water/30 text-pine', text: 'details shared ✓' },
  dropped: { cls: 'bg-pine-soft/15 text-pine-soft', text: 'left' },
};

function StageTracker({ stages, onGo }) {
  return (
    <section className={card} aria-labelledby="stages-title">
      <h2 id="stages-title" className="font-bold">Where we are</h2>
      <ol className="mt-4 grid gap-2 sm:grid-cols-5">
        {stages.map((st, i) => (
          <li key={st.label}>
            <button type="button" onClick={() => onGo(st.tab)} aria-current={st.state === 'current' ? 'step' : undefined}
              className={`flex h-full w-full items-center gap-3 rounded-xl p-3 text-left ring-1 transition hover:ring-coral sm:flex-col sm:items-start ${
                st.state === 'current' ? 'bg-white ring-2 ring-coral' : st.state === 'done' ? 'bg-mint ring-mint-dark' : 'bg-cloud ring-mint-dark'}`}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${
                st.state === 'done' ? 'bg-pine text-cloud' : st.state === 'current' ? 'bg-coral text-cloud' : 'bg-mint-dark text-pine-soft'}`}>
                {st.state === 'done' ? '✓' : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-sm font-medium ${st.state === 'todo' ? 'text-pine-soft' : ''}`}>{st.label}</span>
                <span className="block text-xs text-pine-soft">{st.detail}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function NextStep({ trip, members, myStatus, isOrganizer, myActions, readiness, votes, onGo }) {
  const active = activeMembers(members);
  const waiting = active.filter((m) => m.status === 'invited').length;
  let title;
  let body = null;
  let go = null;

  if (trip.status === 'cancelled') {
    title = 'This trip was cancelled';
  } else if (myActions.length > 0) {
    title = myActions[0].label;
    if (myActions.length > 1) body = `${myActions.length - 1} more to do after this.`;
    go = { tab: ACTION_TAB[myActions[0].kind] ?? 'overview', label: 'Do it now →' };
  } else if (trip.status === 'booked') {
    title = 'You’re all set — this trip is booked 🎉';
  } else if (isOrganizer && EDITABLE_TRIP.has(trip.status) && waiting === 0 && myStatus !== 'invited') {
    title = 'Everyone’s in — ask Pact to find stays';
    go = { tab: 'plan', label: 'Go to Plan →' };
  } else if (isOrganizer && trip.status === 'committing' && readiness?.allSecured) {
    title = 'Everyone has secured their share — you can book';
    go = { tab: 'commit', label: 'Go to Commit →' };
  } else {
    title = 'Waiting for others';
    if (EDITABLE_TRIP.has(trip.status)) body = `${active.length - waiting} of ${active.length} have shared their details.`;
    else if (trip.status === 'voting' && votes) body = `${votes.cast} of ${votes.total} have voted.`;
    else if (COMMIT_STAGE.has(trip.status) && readiness) body = `${readiness.secured} of ${readiness.total} commitments secured.`;
  }

  return (
    <section className="rounded-2xl bg-white p-5 ring-2 ring-coral sm:p-6" aria-labelledby="next-title">
      <p className="text-xs font-bold tracking-wide text-coral-dark uppercase">Your next step</p>
      <h2 id="next-title" className="mt-1 text-lg font-bold">{title}</h2>
      {body && <p className="mt-1 text-sm text-pine-soft">{body}</p>}
      {go && <button type="button" onClick={() => onGo(go.tab)} className={`${btn.base} ${btn.coral} ${btn.small} mt-4`}>{go.label}</button>}
    </section>
  );
}

function Members({ members, meId }) {
  return (
    <section className={`${card} self-start`} aria-labelledby="who-title">
      <h2 id="who-title" className="font-bold">Who’s in</h2>
      <ul className="mt-4 space-y-3">
        {members.map((m) => {
          const chip = MEMBER_CHIP[m.status] ?? MEMBER_CHIP.invited;
          return (
            <li key={m.id} className="flex items-center gap-3">
              <Avatar emoji={m.avatarEmoji} />
              <span className="min-w-0 flex-1 truncate font-medium">{m.name}{m.id === meId ? ' (you)' : ''}</span>
              <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${chip.cls}`}>{chip.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function OverviewTab({ trip, members, myStatus, isOrganizer, meId, myActions, onGo }) {
  const inCommit = COMMIT_STAGE.has(trip.status);
  const { data: readiness, loading: rl } = useApi(inCommit ? `/api/trips/${trip.id}/readiness` : null, { pollMs: 5000 });
  const { data: props, loading: pl } = useApi(trip.status === 'voting' ? `/api/trips/${trip.id}/proposals` : null, { pollMs: 5000 });
  const votes = props
    ? { cast: props.proposals.reduce((n, p) => n + p.voteCount, 0), total: activeMembers(members).length }
    : null;

  if ((inCommit && rl && !readiness) || (trip.status === 'voting' && pl && !props)) {
    return <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-36" /></div>;
  }

  const stages = buildStages({ trip, members, readiness, votes });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-4">
        <NextStep trip={trip} members={members} myStatus={myStatus} isOrganizer={isOrganizer} myActions={myActions}
          readiness={readiness} votes={votes} onGo={onGo} />
        <StageTracker stages={stages} onGo={onGo} />
      </div>
      <Members members={members} meId={meId} />
    </div>
  );
}
