import { TABS } from '../../lib/tripState.js';

function Dot() {
  return <span className="absolute top-1 right-1/4 h-2.5 w-2.5 rounded-full bg-coral ring-2 ring-mint" aria-hidden="true" />;
}

/** Desktop: top tab list. Mobile: fixed bottom bar. `pending` = Set of tab ids with a to-do for me. */
export default function TripTabs({ active, onChange, pending }) {
  const label = (t) => `${t.label}${pending.has(t.id) ? ' (action needed)' : ''}`;
  return (
    <>
      <div role="tablist" aria-label="Trip sections" className="mt-6 hidden gap-1 border-b border-mint-dark md:flex">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={active === t.id}
            aria-controls="trip-panel" aria-label={label(t)} onClick={() => onChange(t.id)}
            className={`relative -mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              active === t.id ? 'border-coral text-pine' : 'border-transparent text-pine-soft hover:text-pine'}`}>
            {t.label}
            {pending.has(t.id) && <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-coral align-middle" aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div role="tablist" aria-label="Trip sections"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-mint-dark bg-mint/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={active === t.id} aria-controls="trip-panel"
            aria-label={label(t)} onClick={() => onChange(t.id)}
            className={`relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active === t.id ? 'text-pine' : 'text-pine-soft'}`}>
            <span className={`grid h-7 w-12 place-items-center rounded-full text-base ${active === t.id ? 'bg-coral/20' : ''}`} aria-hidden="true">{t.icon}</span>
            {t.label}
            {pending.has(t.id) && <Dot />}
          </button>
        ))}
      </div>
    </>
  );
}
