import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useApi } from '../lib/useApi.js';
import { useAuth } from '../lib/auth.jsx';
import { ACTION_TAB } from '../lib/tripState.js';
import TentIcon from './TentIcon.jsx';
import { DemoReset } from './Navbar.jsx';

/** Closes on outside click / Escape. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const panel = 'absolute right-0 top-full z-30 mt-2 rounded-2xl bg-cloud p-1.5 shadow-lg ring-1 ring-mint-dark';

// Only things I can act on right now. "cover" and anything informational are intentionally not listed.
const BELL_ACTION = {
  private_details: 'Share your private details',
  negotiation: 'Answer Pact’s private question',
  vote: 'Cast your vote',
  commit: 'Approve your hold or payment',
  payment_failed: 'Retry your failed payment',
};

function Bell() {
  const { data, reload } = useApi('/api/me/actions', { pollMs: 5000 });
  const { pathname } = useLocation();
  const { open, setOpen, ref } = useMenu();
  const actions = (data ?? []).filter((a) => BELL_ACTION[a.kind]);

  // Refresh right after navigating (e.g. once an action is done).
  useEffect(() => { reload(); }, [pathname]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${actions.length ? `, ${actions.length} to do` : ''}`}
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-full text-lg hover:bg-mint-dark"
      >
        <span aria-hidden="true">🔔</span>
        {actions.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-coral px-1 text-[10px] font-bold text-cloud">
            {actions.length}
          </span>
        )}
      </button>
      {open && (
        <div className={`${panel} w-80 max-w-[calc(100vw-1.5rem)]`}>
          {actions.length === 0 ? (
            <p className="px-3 py-3 text-sm text-pine-soft">You’re all caught up ✨</p>
          ) : (
            <ul>
              {actions.map((a) => (
                <li key={`${a.tripId}-${a.kind}`}>
                  <Link
                    to={`/trips/${a.tripId}/${ACTION_TAB[a.kind] ?? 'overview'}`}
                    onClick={() => setOpen(false)}
                    className="block rounded-xl px-3 py-2 text-sm hover:bg-mint"
                  >
                    <span className="block font-medium">{BELL_ACTION[a.kind]}</span>
                    <span className="block truncate text-xs text-pine-soft">{a.tripTitle} · {a.groupName}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function UserMenu({ user }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { open, setOpen, ref } = useMenu();
  const item = 'block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-mint';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-sm hover:bg-mint-dark"
      >
        <span className="grid h-8 w-8 place-items-center rounded-full bg-cloud text-base" aria-hidden="true">
          {user.avatarEmoji}
        </span>
        <span className="hidden max-w-[10ch] truncate sm:inline">{user.name}</span>
        <span aria-hidden="true" className="text-[10px] text-pine-soft">▾</span>
      </button>
      {open && (
        <div className={`${panel} w-40`} role="menu">
          <Link to="/profile" role="menuitem" onClick={() => setOpen(false)} className={item}>Profile</Link>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={async () => {
              setOpen(false);
              await logout();
              navigate('/', { replace: true });
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export default function AppNavbar() {
  const { user } = useAuth();
  return (
    <header className="sticky top-0 z-20 border-b border-mint-dark bg-mint/90 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <Link to="/dashboard" className="flex shrink-0 items-center gap-2 text-lg font-bold">
          <TentIcon />
          Pact
        </Link>
        <div className="ml-auto flex items-center gap-2">
          {user && (
            <>
              <DemoReset userId={user.id} />
              <Bell />
              <UserMenu user={user} />
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
