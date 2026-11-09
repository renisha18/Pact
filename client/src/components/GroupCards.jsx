import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { btn, card, TripStatusChip } from './ui.jsx';
import PixelCamp from './PixelCamp.jsx';

function AvatarStack({ emojis }) {
  return (
    <div className="flex -space-x-2" aria-hidden="true">
      {emojis.map((e, i) => (
        <span key={i} className="grid h-7 w-7 place-items-center rounded-full bg-mint text-sm ring-2 ring-cloud">{e}</span>
      ))}
    </div>
  );
}

export default function GroupCards({ onCreate }) {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    api('/api/groups', { signal: ctrl.signal })
      .then(setGroups)
      .catch((err) => err.name !== 'AbortError' && setError(true));
    return () => ctrl.abort();
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 pb-16">
      <section aria-labelledby="create-new">
        <h1 id="create-new" className="mb-4 text-2xl font-bold">Create new</h1>
        <div className={`${card} flex flex-col items-center gap-5 sm:flex-row`}>
          <PixelCamp className="h-24 w-full max-w-60 shrink-0 overflow-hidden rounded-xl sm:w-60" />
          <div className="flex-1 text-center sm:text-left">
            <p className="font-bold">Planning a trip with friends?</p>
            <p className="mt-1 text-sm text-pine-soft">Start a group, invite everyone, keep budgets private.</p>
          </div>
          <button type="button" onClick={onCreate} className={`${btn.base} ${btn.coral} shrink-0`}>Create a group</button>
        </div>
      </section>

      <section aria-labelledby="your-groups">
        <h2 id="your-groups" className="mb-4 text-2xl font-bold">Groups</h2>
        {error && <p className="text-sm text-coral-dark">Couldn’t load your groups. Try refreshing.</p>}
        {groups === null && !error && <div className="h-36 animate-pulse rounded-2xl bg-mint-dark/60" aria-hidden="true" />}
        {groups?.length === 0 && (
          <div className={`${card} flex flex-col items-center text-center`}>
            <PixelCamp className="h-20 w-52 overflow-hidden rounded-xl" />
            <p className="mt-4 text-sm text-pine-soft">No groups yet — start one above.</p>
          </div>
        )}
        {groups?.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((g) => (
              <Link
                key={g.id}
                to={`/groups/${g.id}`}
                className="relative rounded-2xl bg-cloud p-5 shadow-sm ring-1 ring-mint-dark transition hover:-translate-y-0.5 hover:shadow"
              >
                {g.actionNeeded && (
                  <span className="absolute top-4 right-4 rounded-full bg-coral px-2.5 py-0.5 text-[11px] font-bold text-cloud">
                    Action needed
                  </span>
                )}
                <div className="text-3xl" aria-hidden="true">{g.emoji}</div>
                <div className="mt-2 font-bold">{g.name}</div>
                <div className="mt-2 flex items-center gap-2 text-sm text-pine-soft">
                  <AvatarStack emojis={g.memberAvatars} />
                  <span>{g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  {g.latestTrip ? (
                    <>
                      <span className="truncate">{g.latestTrip.title}</span>
                      <TripStatusChip status={g.latestTrip.status} />
                    </>
                  ) : (
                    <span className="text-pine-soft">No trip planned yet</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
