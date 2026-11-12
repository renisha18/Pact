import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { useToast } from '../lib/toast.jsx';
import { todayIso } from '../lib/format.js';
import { btn, input, label, ErrorNote } from './ui.jsx';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href]';

export default function PlanTripModal({ groupId, onClose }) {
  const navigate = useNavigate();
  const toast = useToast();
  const ref = useRef(null);
  const [title, setTitle] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [nights, setNights] = useState('4');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const today = todayIso();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector('input')?.focus();
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const els = [...ref.current.querySelectorAll(FOCUSABLE)];
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, []);

  async function submit(e) {
    e.preventDefault();
    const n = Number(nights);
    if (!Number.isInteger(n) || n < 1 || n > 14) return setError('Trip length must be 1–14 nights.');
    if ((Date.parse(windowEnd) - Date.parse(windowStart)) / 86_400_000 < n) {
      return setError('The date window must be at least as long as the trip.');
    }
    setSaving(true);
    setError(null);
    try {
      const trip = await api(`/api/groups/${groupId}/trips`, { method: 'POST', body: { title: title.trim(), windowStart, windowEnd, nights: n } });
      toast('Trip created — everyone’s invited to share their details');
      navigate(`/trips/${trip.id}/plan`);
    } catch (err) {
      setError(err.status === 400 ? 'Check the title, window and trip length (1–14 nights).' : err.message);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-pine/50 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form ref={ref} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="pt-title"
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-cloud p-5 shadow-xl sm:max-w-md sm:rounded-3xl sm:p-7">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="pt-title" className="text-xl font-bold">Plan a new trip</h2>
            <p className="mt-1 text-sm text-pine-soft">Everyone in the group is invited to share their budget privately.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-pine-soft hover:bg-mint-dark">✕</button>
        </div>
        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="pt-name" className={label}>Title</label>
            <input id="pt-name" className={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required placeholder="Bali, finally" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pt-start" className={label}>Earliest start</label>
              <input id="pt-start" type="date" className={input} value={windowStart} min={today} onChange={(e) => setWindowStart(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="pt-end" className={label}>Latest end</label>
              <input id="pt-end" type="date" className={input} value={windowEnd} min={windowStart || today} onChange={(e) => setWindowEnd(e.target.value)} required />
            </div>
          </div>
          <div>
            <label htmlFor="pt-nights" className={label}>Trip length (nights)</label>
            <input id="pt-nights" type="number" min={1} max={14} className={input} value={nights} onChange={(e) => setNights(e.target.value)} required />
            <p className="mt-1 text-xs text-pine-soft">Everyone picks the days they’re free; Pact finds the dates.</p>
          </div>
          <ErrorNote>{error}</ErrorNote>
          <button type="submit" disabled={saving} className={`${btn.base} ${btn.coral} w-full`}>{saving ? 'Creating…' : 'Start planning →'}</button>
        </div>
      </form>
    </div>
  );
}
