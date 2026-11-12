import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../lib/useApi.js';
import { formatDate, formatRange, parseDate } from '../../lib/format.js';
import { PixelLock } from '../Planning.jsx';
import { ErrorNote, Loading, btn, card } from '../ui.jsx';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function addDays(isoDay, n) {
  const d = parseDate(isoDay);
  d.setDate(d.getDate() + n);
  return iso(d);
}

/** "3–6 Dec", or "30 Nov–3 Dec" across months. */
function formatBlock(b) {
  const s = parseDate(b.startDate);
  const e = parseDate(b.endDate);
  const mon = (d) => d.toLocaleDateString(undefined, { month: 'short' });
  return s.getMonth() === e.getMonth()
    ? `${s.getDate()}–${e.getDate()} ${mon(e)}`
    : `${s.getDate()} ${mon(s)}–${e.getDate()} ${mon(e)}`;
}

function windowDays(start, end) {
  const out = [];
  for (let d = parseDate(start); iso(d) <= end; d.setDate(d.getDate() + 1)) out.push(iso(d));
  return out;
}

/** "When can you go?": my private days, plus the organizer's pick when no window fits everyone. */
export default function DatesCard({ tripId, isOrganizer, editable, refreshKey, onChanged }) {
  const { data, loading, reload } = useApi(`/api/trips/${tripId}/availability`);
  const [blocks, setBlocks] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { reload(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data) setBlocks(data.blocks); }, [data]);

  if (loading && !data) return <section className={card}><Loading /></section>;
  if (!data?.windowStart) return null; // trip with fixed dates
  const chosen = data.datesStatus === 'chosen';
  if (chosen && !data.nudge) return null;

  const days = windowDays(data.windowStart, data.windowEnd);
  // Tapping a day picks a block of trip-length nights starting there; blocks past the window end are disabled.
  const endOf = (d) => addDays(d, data.nights);
  const fits = (d) => endOf(d) <= data.windowEnd;
  const covered = new Set(blocks.flatMap((b) => windowDays(b.startDate, b.endDate)));
  const addBlock = (d) => setBlocks((bs) => (bs.some((b) => b.startDate === d) ? bs : [...bs, { startDate: d, endDate: endOf(d) }]
    .sort((x, y) => x.startDate.localeCompare(y.startDate))));
  const removeBlock = (d) => setBlocks((bs) => bs.filter((b) => b.startDate !== d));

  async function save() {
    if (blocks.length === 0) return setError('Pick at least one block of days.');
    setSaving(true);
    setError(null);
    try {
      await api(`/api/trips/${tripId}/availability`, { method: 'PUT', body: { blocks } });
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
          <p className="mt-4 text-sm text-pine-soft">
            Tap a day to pick a {data.nights}-night block starting then. Add as many blocks as you like.
          </p>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Start days">
            {days.map((d) => (
              <button key={d} type="button" disabled={!editable || saving || !fits(d)} aria-pressed={covered.has(d)} onClick={() => addBlock(d)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition disabled:opacity-40 ${
                  covered.has(d) ? 'bg-pine text-cloud ring-pine' : 'bg-white ring-mint-dark hover:ring-coral'}`}>
                {formatDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}
              </button>
            ))}
          </div>
          {blocks.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Your blocks">
              {blocks.map((b) => (
                <li key={b.startDate} className="inline-flex items-center gap-1 rounded-full bg-mint py-1 pr-1 pl-3 text-sm font-medium ring-1 ring-mint-dark">
                  {formatBlock(b)}
                  {editable && (
                    <button type="button" onClick={() => removeBlock(b.startDate)} aria-label={`Remove ${formatBlock(b)}`}
                      className="grid h-6 w-6 place-items-center rounded-full text-pine-soft hover:bg-mint-dark">✕</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={save} disabled={saving || blocks.length === 0} className={`${btn.base} ${btn.coral} ${btn.small}`}>
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
