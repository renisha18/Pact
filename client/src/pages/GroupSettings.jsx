import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/useApi.js';
import { Page, Loading, ErrorNote, NotFoundCard, btn, card, input, label } from '../components/ui.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import { EmojiPicker, VibePicker } from '../components/GroupFields.jsx';

const LEAVE_MSG = 'You have unsaved changes. Leave without saving?';

function SettingsForm({ group, isOrganizer }) {
  const navigate = useNavigate();
  const initial = { name: group.name, emoji: group.emoji, description: group.description, personality: group.personality };
  const [f, setF] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const dirty = Object.keys(initial).some((k) => initial[k] !== f[k]);
  const valid = f.name.trim().length >= 1 && f.name.trim().length <= 40 && f.description.length <= 160;
  const ro = !isOrganizer;
  const back = `/groups/${group.id}`;

  // Unsaved-changes guard: tab close/refresh, and any in-app link click.
  useEffect(() => {
    if (!dirty) return undefined;
    const onUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    const onClick = (e) => {
      const a = e.target.closest?.('a[href^="/"]');
      if (a && !window.confirm(LEAVE_MSG)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`/api/groups/${group.id}`, {
        method: 'PATCH',
        body: { name: f.name.trim(), emoji: f.emoji, description: f.description.trim(), personality: f.personality },
      });
      navigate(back, { state: { toast: 'Group settings saved' } });
    } catch (err) {
      setError(err.status === 400 ? 'Check the name (1–40) and description (up to 160 characters).' : err.message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className={`${card} mt-4 space-y-6`}>
      {ro && <p className="rounded-xl bg-mint px-3 py-2 text-sm text-pine-soft">Only the organizer can change these.</p>}
      <div>
        <label htmlFor="gs-name" className={label}>Group name</label>
        <input id="gs-name" className={input} value={f.name} maxLength={40} readOnly={ro} onChange={(e) => set('name')(e.target.value)} />
        <p className="mt-1 text-right text-xs text-pine-soft" aria-live="polite">{f.name.length}/40</p>
      </div>
      <EmojiPicker value={f.emoji} onChange={set('emoji')} disabled={ro} />
      <div>
        <label htmlFor="gs-desc" className={label}>Description</label>
        <textarea id="gs-desc" rows={3} className={input} value={f.description} maxLength={160} readOnly={ro}
          placeholder="What’s this group about?" onChange={(e) => set('description')(e.target.value)} />
        <p className="mt-1 text-right text-xs text-pine-soft" aria-live="polite">{f.description.length}/160</p>
      </div>
      <div>
        <h2 className={label}>Pact’s vibe</h2>
        <VibePicker value={f.personality} onChange={set('personality')} disabled={ro} />
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!ro && (
        <button type="submit" disabled={saving || !valid || !dirty} className={`${btn.base} ${btn.coral} w-full`}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      )}
    </form>
  );
}

export default function GroupSettings() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, error, loading } = useApi(`/api/groups/${encodeURIComponent(id)}`);

  if (loading) return <Page narrow><Loading /></Page>;
  if (error) {
    return (
      <Page narrow>
        {error.status === 404 ? <NotFoundCard what="group" /> : <ErrorNote>{error.message}</ErrorNote>}
      </Page>
    );
  }
  const isOrganizer = data.members.some((m) => m.id === user.id && m.role === 'organizer');
  return (
    <Page narrow>
      <Breadcrumbs items={[{ label: 'Dashboard', to: '/dashboard' }, { label: data.group.name, to: `/groups/${data.group.id}` }, { label: 'Settings' }]} />
      <Link to={`/groups/${data.group.id}`} className="text-sm text-pine-soft hover:text-pine">← Back to group</Link>
      <h1 className="mt-3 text-2xl font-bold">Group settings</h1>
      <SettingsForm group={data.group} isOrganizer={isOrganizer} />
    </Page>
  );
}
