import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../lib/useApi.js';
import { PixelLock } from '../Planning.jsx';
import { ErrorNote, btn, card, input, label } from '../ui.jsx';

const COMMIT_OPTIONS = [
  { value: 'hold', emoji: '🔒', title: 'Hold now', body: 'Place a PayPal hold for my share as soon as we agree.' },
  { value: 'pay_by_date', emoji: '📅', title: 'Pay by a date', body: 'I’m in, but I’ll pay closer to the deadline.' },
  { value: 'need_time', emoji: '⏳', title: 'Need more time', body: 'I want in but need a little longer to sort money.' },
];
const ROAST_LEVELS = ['off', 'mild', 'savage'];

const centsToUsd = (cents) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

export default function PrivateForm({ tripId, editable, onSaved }) {
  const { data: existing, error: loadError, loading } = useApi(`/api/trips/${tripId}/private-input`);
  const [form, setForm] = useState({
    budget: '', preferencesText: '', comfortText: '', commitmentType: '', roastLevel: 'mild',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    if (existing) {
      setForm({
        budget: centsToUsd(existing.maxBudgetCents),
        preferencesText: existing.preferencesText,
        comfortText: existing.comfortText,
        commitmentType: existing.commitmentType ?? '',
        roastLevel: existing.roastLevel,
      });
      setSavedAt(existing.updatedAt);
    }
  }, [existing]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    const budget = Number(form.budget);
    if (!(budget >= 1 && budget <= 10000)) return setError('Budget must be between $1 and $10,000.');
    if (!form.commitmentType) return setError('Pick how you’ll commit.');
    setSaving(true);
    setError(null);
    try {
      const saved = await api(`/api/trips/${tripId}/private-input`, {
        method: 'PUT',
        body: {
          maxBudgetUsd: budget,
          preferencesText: form.preferencesText,
          comfortText: form.comfortText,
          commitmentType: form.commitmentType,
          roastLevel: form.roastLevel,
        },
      });
      setSavedAt(saved.updatedAt);
      onSaved();
    } catch (err) {
      setError(err.status === 400 ? 'Check your budget (up to 2 decimals) and text lengths.' : err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className={card}><Loading /></section>;

  return (
    <form onSubmit={submit} className={card} aria-labelledby="private-title">
      <h2 id="private-title" className="text-lg font-bold">Your private details</h2>
      <p className="mt-1 flex items-center gap-2 text-sm text-pine-soft">
        <PixelLock /> Only you and the Pact agent see this.
      </p>
      <ErrorNote>{loadError && 'Couldn’t load your saved details.'}</ErrorNote>

      <fieldset disabled={!editable || saving} className="mt-5 space-y-5 disabled:opacity-70">
        <div>
          <label htmlFor="budget" className={label}>Max budget for the stay (USD)</label>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-pine-soft">$</span>
            <input id="budget" type="number" inputMode="decimal" min="1" max="10000" step="0.01" required
              value={form.budget} onChange={set('budget')} className={`${input} pl-7`} placeholder="400" />
          </div>
        </div>

        <div>
          <label htmlFor="prefs" className={label}>Nice-to-haves — Pact may suggest trade-offs</label>
          <textarea id="prefs" rows={3} maxLength={500} value={form.preferencesText} onChange={set('preferencesText')}
            className={input} placeholder="A pool, near the surf, a kitchen for group dinners…" />
          <p className="mt-1 text-right text-xs text-pine-soft">{form.preferencesText.length}/500</p>
        </div>

        <div>
          <label htmlFor="comfort" className={label}>Must-haves — Pact will never ask you to change these</label>
          <textarea id="comfort" rows={2} maxLength={300} value={form.comfortText} onChange={set('comfortText')}
            className={input} placeholder="Dorms, long drives, loud party spots…" />
          <p className="mt-1 text-right text-xs text-pine-soft">{form.comfortText.length}/300</p>
        </div>

        <fieldset>
          <legend className={label}>How you’ll commit</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {COMMIT_OPTIONS.map((o) => (
              <label key={o.value} className="cursor-pointer">
                <input type="radio" name="commitmentType" value={o.value} checked={form.commitmentType === o.value}
                  onChange={set('commitmentType')} className="peer sr-only" />
                <span className="block h-full rounded-xl bg-mint p-3 ring-1 ring-mint-dark transition peer-checked:bg-white peer-checked:ring-2 peer-checked:ring-coral peer-focus-visible:outline-2 peer-focus-visible:outline-coral">
                  <span className="block text-xl" aria-hidden="true">{o.emoji}</span>
                  <span className="mt-1 block font-bold">{o.title}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-pine-soft">{o.body}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className={label}>Roast level</legend>
          <div className="inline-flex rounded-full bg-mint p-1 ring-1 ring-mint-dark">
            {ROAST_LEVELS.map((r) => (
              <label key={r} className="cursor-pointer">
                <input type="radio" name="roastLevel" value={r} checked={form.roastLevel === r}
                  onChange={set('roastLevel')} className="peer sr-only" />
                <span className="block rounded-full px-4 py-1.5 text-sm capitalize transition peer-checked:bg-coral peer-checked:text-cloud peer-focus-visible:outline-2 peer-focus-visible:outline-coral">
                  {r}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-pine-soft">How cheeky the agent can be with you.</p>
        </fieldset>
      </fieldset>

      <div className="mt-6 space-y-3">
        <ErrorNote>{error}</ErrorNote>
        {editable ? (
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={saving} className={`${btn.base} ${btn.coral}`}>
              {saving ? 'Saving…' : savedAt ? 'Update my details' : 'Save privately'}
            </button>
            {savedAt && !saving && <span className="text-sm text-pine-soft" aria-live="polite">Saved ✓</span>}
          </div>
        ) : (
          <p className="text-sm text-pine-soft">Your details are locked for this trip.</p>
        )}
      </div>
    </form>
  );
}
