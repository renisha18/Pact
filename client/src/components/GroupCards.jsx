import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { formatDate } from '../lib/format.js';

export default function GroupCards({ title = 'Your groups', headingLevel: H = 'h2' }) {
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
    <section className="mx-auto max-w-5xl px-4 pb-16" aria-labelledby="your-groups">
      <H id="your-groups" className="mb-4 text-2xl font-bold">{title}</H>
      {error && <p className="text-sm text-coral-dark">Couldn’t load your groups. Try refreshing.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groups?.map((g) => (
          <Link
            key={g.id}
            to={`/groups/${g.id}`}
            className="rounded-2xl bg-cloud p-5 shadow-sm ring-1 ring-mint-dark transition hover:-translate-y-0.5 hover:shadow"
          >
            <div className="mb-2 text-3xl" aria-hidden="true">{g.emoji}</div>
            <div className="font-bold">{g.name}</div>
            <div className="mt-1 text-sm text-pine-soft">
              {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}
            </div>
            <div className="mt-3 text-sm">
              {g.nextTrip ? (
                <>Next: {g.nextTrip.title} · {formatDate(g.nextTrip.startDate)}</>
              ) : (
                <span className="text-pine-soft">No trip planned yet</span>
              )}
            </div>
          </Link>
        ))}
        {groups === null && !error && (
          <div className="h-36 animate-pulse rounded-2xl bg-mint-dark/60" aria-hidden="true" />
        )}
        <Link
          to="/groups/new"
          className="flex min-h-36 flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-water p-5 text-pine-soft transition hover:border-coral hover:text-pine"
        >
          <span className="text-2xl" aria-hidden="true">＋</span>
          Create a group
        </Link>
      </div>
    </section>
  );
}
