import { Link, NavLink } from 'react-router';
import { useAuth } from '../lib/auth.jsx';
import TentIcon from './TentIcon.jsx';

const pill = 'inline-flex items-center rounded-full font-medium transition-colors';

export default function Navbar() {
  const { user, loading, logout } = useAuth();

  return (
    <header className="sticky top-0 z-20 border-b border-mint-dark bg-mint/90 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <Link to="/" className="flex shrink-0 items-center gap-2 text-lg font-bold">
          <TentIcon />
          Pact
        </Link>

        <div className="hidden flex-1 items-center justify-center gap-6 text-sm md:flex">
          <Link to={{ pathname: '/', hash: '#how' }} className="text-pine-soft hover:text-pine">
            How it works
          </Link>
          {user && (
            <NavLink
              to="/groups"
              className={({ isActive }) => (isActive ? 'text-pine' : 'text-pine-soft hover:text-pine')}
            >
              Groups
            </NavLink>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <span
            className={`${pill} border border-water bg-cloud px-2.5 py-1 text-[10px] tracking-wide text-pine-soft`}
            title="PayPal sandbox only. No real money moves."
          >
            SANDBOX<span className="hidden sm:inline">&nbsp;· no real money</span>
          </span>

          {loading ? (
            <span className="h-8 w-20" aria-hidden="true" />
          ) : user ? (
            <>
              <span className="flex items-center gap-1.5 text-sm">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-cloud text-base" aria-hidden="true">
                  {user.avatarEmoji}
                </span>
                <span className="hidden max-w-[10ch] truncate sm:inline">{user.name}</span>
              </span>
              <button
                type="button"
                onClick={logout}
                className={`${pill} px-3 py-1.5 text-sm text-pine-soft hover:bg-mint-dark hover:text-pine`}
              >
                Log out
              </button>
            </>
          ) : (
            <Link to="/login" className={`${pill} bg-coral px-4 py-1.5 text-sm text-cloud hover:bg-coral-dark`}>
              Log in
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
