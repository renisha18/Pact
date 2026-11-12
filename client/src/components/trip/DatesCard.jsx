import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../lib/useApi.js';
import { formatDate, formatRange, parseDate } from '../../lib/format.js';
import { PixelLock } from '../Planning.jsx';
import { ErrorNote, Loading, btn, card } from '../ui.jsx';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function windowDays(start, end) {
  const out = [];
  for (let d = parseDate(start); iso(d) <= end; d.setDate(d.getDate() + 1)) out.push(iso(d));
  return out;
}

/** "When can you go?": my private days, plus the organizer's pick when no window fits everyone. */
export default function DatesCard({ tripId, isOrganizer, editable, refreshKey, onChanged }) {
  const { data, loading, reload } = useApi(`/api/trips/${tripId}/availability`);
  const [picked, setPicked] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { reload(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data) setPicked(new Set(data.days)); }, [data]);

  if (loading && !data) return <section className={card}><Loading /></section>;
  if (!data?.windowStart) return null; // trip with fixed dates
  const chosen = data.datesStatus === 'chosen';
  if (chosen && !data.nudge) return null;

  const days = windowDays(data.windowStart, data.windowEnd);
  const toggle = (d) => setPicked((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; });
  const allOn = picked.size === days.length;

  async function save() {
    if (picked.size === 0) return setError('Pick at least one day.');
    setSaving(true);
    setError(null);
    try {
      await api(`/api/trips/${tripId}/availability`, { method: 'PUT', body: { days: [...picked].sort() } });
      setSaved(true);
      await reload();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function choose(startDate) {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/trips/${tripId}/dates`, { method: 'POST', body: { startDate } });
      await reload();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={card} aria-labelledby="dates-title">
      <h2 id="dates-title" className="text-lg font-bold">When can you go?</h2>
      <p className="mt-1 flex items-center gap-2 text-sm text-pine-soft">
        <PixelLock /> Only you see your days. Trip length: {data.nights} {data.nights === 1 ? 'night' : 'nights'}, between{' '}
        {formatRange(data.windowStart, data.windowEnd)}.
      </p>

      {data.nudge && <p className="mt-4 rounded-xl bg-coral/10 p-3 text-sm" role="status">{data.nudge}</p>}

      {!chosen && (
        <>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Days you can go">
            {days.map((d) => (
              <button key={d} type="button" disabled={!editable || saving} aria-pressed={picked.has(d)} onClick={() => toggle(d)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition disabled:opacity-60 ${
                  picked.has(d) ? 'bg-pine text-cloud ring-pine' : 'bg-white ring-mint-dark hover:ring-coral'}`}>
                {formatDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}
              </button>
            ))}
          </div>
          {editable && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => setPicked(new Set(allOn ? [] : days))} className={`${btn.base} ${btn.small}`}>
                {allOn ? 'Clear all' : 'Select all'}
              </button>
              <button type="button" onClick={save} disabled={saving} className={`${btn.base} ${btn.coral} ${btn.small}`}>
                {saving ? 'Saving…' : data.submitted ? 'Update my days' : 'Save my days'}
              </button>
              {saved && <span className="text-sm text-pine-soft" role="status">Saved privately ✓</span>}
            </div>
          )}
        </>
      )}

      {data.datesStatus === 'pick' && data.options.length > 0 && (
        <div className="mt-6">
          <h3 className="font-bold">No dates work for everyone</h3>
          <p className="mt-1 text-sm text-pine-soft">
            {isOrganizer ? 'Pick the closest window.' : 'The organizer will pick the closest window.'}
          </p>
          <ul className="mt-3 space-y-2">
            {data.options.map((o) => (
              <li key={o.startDate} className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-mint-dark">
                <span className="font-medium">{formatRange(o.startDate, o.endDate)}</span>
                <span className="text-sm text-pine-soft">{o.availableCount} of {o.total} free</span>
                {isOrganizer && (
                  <button type="button" disabled={saving} onClick={() => choose(o.startDate)}
                    className={`${btn.base} ${btn.coral} ${btn.small} ml-auto`}>Choose</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNote>{error}</ErrorNote>
    </section>
  );
}
