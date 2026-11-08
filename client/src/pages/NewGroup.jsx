import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { Page, ErrorNote, btn, card, input, label } from '../components/ui.jsx';

const EMOJIS = ['🏝️', '🏄', '🌋', '🌿', '🎒', '🍹', '🐢', '🌅'];
const PERSONALITIES = [
  { value: 'chill', title: 'Chill', blurb: 'Laid-back nudges.' },
  { value: 'wholesome', title: 'Wholesome', blurb: 'Warm and encouraging.' },
  { value: 'savage', title: 'Savage', blurb: 'Friendly roasts for slowpokes.' },
];

export default function NewGroup() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJIS[0]);
  const [personality, setPersonality] = useState('chill');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const group = await api('/api/groups', { method: 'POST', body: { name: name.trim(), emoji, personality } });
      navigate(`/groups/${group.id}`);
    } catch (err) {
      setError(err.status === 400 ? 'Check the group name (1–40 characters).' : err.message);
      setSaving(false);
    }
  }

  return (
    <Page narrow>
      <h1 className="text-3xl font-bold">New group</h1>
      <form onSubmit={submit} className={`${card} mt-6 space-y-6`}>
        <div>
          <label htmlFor="name" className={label}>Group name</label>
          <input
            id="name"
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            required
            placeholder="e.g. Uni Crew Escape"
            autoFocus
          />
        </div>

        <fieldset>
          <legend className={label}>Emoji</legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {EMOJIS.map((e) => (
              <label key={e} className="cursor-pointer">
                <input type="radio" name="emoji" value={e} checked={emoji === e} onChange={() => setEmoji(e)} className="peer sr-only" />
                <span className="grid h-12 place-items-center rounded-xl bg-mint text-2xl ring-1 ring-mint-dark transition peer-checked:bg-white peer-checked:ring-2 peer-checked:ring-coral peer-focus-visible:outline-2 peer-focus-visible:outline-coral">
                  {e}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className={label}>Agent personality</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {PERSONALITIES.map((p) => (
              <label key={p.value} className="cursor-pointer">
                <input
                  type="radio"
                  name="personality"
                  value={p.value}
                  checked={personality === p.value}
                  onChange={() => setPersonality(p.value)}
                  className="peer sr-only"
                />
                <span className="block h-full rounded-xl bg-mint p-3 ring-1 ring-mint-dark transition peer-checked:bg-white peer-checked:ring-2 peer-checked:ring-coral peer-focus-visible:outline-2 peer-focus-visible:outline-coral">
                  <span className="block font-bold">{p.title}</span>
                  <span className="block text-xs text-pine-soft">{p.blurb}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <ErrorNote>{error}</ErrorNote>
        <button type="submit" disabled={saving || !name.trim()} className={`${btn.base} ${btn.coral} w-full`}>
          {saving ? 'Creating…' : 'Create group →'}
        </button>
      </form>
    </Page>
  );
}
