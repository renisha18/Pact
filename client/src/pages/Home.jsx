import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { useAuth } from '../lib/auth.jsx';
import PixelScene from '../components/PixelScene.jsx';

const FEATURES = [
  { emoji: '🤫', title: 'Private budgets', body: 'Tell Pact what you can spend. Nobody else ever sees it.' },
  { emoji: '🤝', title: 'Commit together', body: 'Everyone locks in their share before anything is booked.' },
  { emoji: '🎒', title: 'Nobody fronts', body: 'No more paying for everyone and chasing them for weeks.' },
];

const STEPS = [
  { title: 'Share privately', body: 'Each person adds a budget and what they care about. Only they can see it.' },
  { title: 'Agent proposes', body: 'Pact suggests stays that fit everyone, without revealing anyone’s numbers.' },
  { title: 'Everyone commits', body: 'The group votes, then each person holds their share. Everyone pays the same share; your private budget only decides which stays the group considers.' },
  { title: 'Booked, nobody fronted', body: 'Once everyone is in, it’s booked. No IOUs, no chasing.' },
];

const btn = 'inline-flex items-center justify-center rounded-full px-6 py-3 font-medium transition-colors';

export default function Home() {
  const { user } = useAuth();
  const { hash } = useLocation();

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  const createHref = user ? '/dashboard' : `/login?next=${encodeURIComponent('/dashboard')}`;

  return (
    <main>
      <section className="mx-auto max-w-5xl px-4 pt-12 text-center sm:pt-16">
        <h1 className="mx-auto max-w-3xl text-3xl leading-tight font-bold text-balance sm:text-5xl">
          Always the one who plans the trip?
        </h1>
        <p className="mt-3 text-lg font-bold text-coral-dark sm:text-xl">Agree privately. Commit together.</p>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-pretty text-pine-soft sm:text-lg">
          And the one left chasing everyone for money after? Pact lets your group commit together — budgets stay
          private, nobody fronts the cash, and no one gets left out.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to={createHref} className={`${btn} bg-coral text-cloud hover:bg-coral-dark`}>
            Want to form a group?
          </Link>
          <Link
            to={{ hash: '#how' }}
            className={`${btn} bg-cloud text-pine ring-1 ring-mint-dark hover:bg-white`}
          >
            How it works
          </Link>
        </div>

        <div className="mx-auto mt-10 max-w-4xl overflow-hidden rounded-3xl ring-1 ring-mint-dark">
          <PixelScene />
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-4 py-14 sm:grid-cols-3" aria-label="Why Pact">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-2xl bg-cloud p-6 ring-1 ring-mint-dark">
            <div className="text-3xl" aria-hidden="true">{f.emoji}</div>
            <h2 className="mt-3 font-bold">{f.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-pine-soft">{f.body}</p>
          </div>
        ))}
      </section>

      <section id="how" className="scroll-mt-20 bg-mint-dark/50 py-16" aria-labelledby="how-title">
        <div className="mx-auto max-w-5xl px-4">
          <h2 id="how-title" className="text-center text-2xl font-bold sm:text-3xl">How it works</h2>
          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-2xl bg-cloud p-6 ring-1 ring-mint-dark">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-coral text-sm font-bold text-cloud">
                  {i + 1}
                </span>
                <h3 className="mt-4 font-bold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-pine-soft">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <footer className="py-8 text-center text-xs text-pine-soft">
        Pact · Plan trips together, privately
      </footer>
    </main>
  );
}
