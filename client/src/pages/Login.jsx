import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/useApi.js';
import { safeNext } from '../lib/format.js';
import { Page, Loading, ErrorNote, Avatar } from '../components/ui.jsx';

export default function Login() {
  const { data: users, error, loading } = useApi('/api/auth/demo-users');
  const { user, refresh } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [pending, setPending] = useState(null);
  const [loginError, setLoginError] = useState(null);
  const next = safeNext(params.get('next'));

  async function login(userId) {
    setPending(userId);
    setLoginError(null);
    try {
      await api('/api/auth/demo-login', { method: 'POST', body: { userId } });
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setLoginError(err.message);
      setPending(null);
    }
  }

  return (
    <Page narrow>
      <h1 className="text-center text-3xl font-bold">Who are you?</h1>
      <p className="mt-3 text-center text-sm text-pine-soft">
        Demo mode: pick a friend to sign in as. No passwords.
      </p>
      <div className="mt-8 space-y-4">
        {loading && <Loading />}
        <ErrorNote>{error && 'Couldn’t load demo users. Is the server running?'}</ErrorNote>
        <ErrorNote>{loginError}</ErrorNote>
        {users && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {users.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => login(u.id)}
                  disabled={pending !== null}
                  aria-current={user?.id === u.id ? 'true' : undefined}
                  className="flex w-full flex-col items-center gap-2 rounded-2xl bg-cloud p-5 ring-1 ring-mint-dark transition hover:-translate-y-0.5 hover:ring-coral disabled:opacity-60 aria-[current]:ring-2 aria-[current]:ring-coral"
                >
                  <Avatar emoji={u.avatarEmoji} size="h-14 w-14 text-3xl" />
                  <span className="font-bold">{u.name}</span>
                  <span className="h-4 text-xs text-pine-soft">
                    {pending === u.id ? 'Signing in…' : user?.id === u.id ? 'current' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}
