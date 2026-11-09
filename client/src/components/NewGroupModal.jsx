import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { btn, input, label, ErrorNote } from './ui.jsx';
import { EMOJIS, EmojiPicker, VibePicker } from './GroupFields.jsx';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function Dots({ step }) {
  return (
    <ol className="flex justify-center gap-2" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((n) => (
        <li key={n} aria-current={n === step ? 'step' : undefined}
          className={`h-2 rounded-full transition-all ${n === step ? 'w-6 bg-coral' : n < step ? 'w-2 bg-coral/50' : 'w-2 bg-mint-dark'}`} />
      ))}
    </ol>
  );
}

function InviteStep({ group, inviteUrl, onDone }) {
  const [copied, setCopied] = useState(false);
  const text = `Join "${group.name}" on Pact — we're planning a trip together and nobody has to front the money: ${inviteUrl}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the field is selectable */ }
  }

  return (
    <>
      <h2 id="ngm-title" className="text-xl font-bold">Invite your friends</h2>
      <p className="mt-1 text-sm text-pine-soft">Anyone with the link can join {group.name}.</p>
      <div className="mt-5 flex gap-2">
        <input readOnly aria-label="Invite link" className={input} value={inviteUrl ?? 'Loading…'} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={copy} disabled={!inviteUrl} className={`${btn.base} ${btn.cloud} ${btn.small} shrink-0`}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <a target="_blank" rel="noopener noreferrer" aria-disabled={!inviteUrl}
          href={inviteUrl ? `https://wa.me/?text=${encodeURIComponent(text)}` : undefined}
          className={`${btn.base} ${btn.cloud} ${btn.small} flex-1`}>Share on WhatsApp</a>
        <a aria-disabled={!inviteUrl}
          href={inviteUrl ? `mailto:?subject=${encodeURIComponent(`Join ${group.name} on Pact`)}&body=${encodeURIComponent(text)}` : undefined}
          className={`${btn.base} ${btn.cloud} ${btn.small} flex-1`}>Share by email</a>
      </div>
      <button type="button" onClick={onDone} className={`${btn.base} ${btn.coral} mt-6 w-full`}>Go to group →</button>
    </>
  );
}

/** onClose(created: boolean) — called when the modal is dismissed. */
export default function NewGroupModal({ onClose }) {
  const navigate = useNavigate();
  const dialogRef = useRef(null);
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJIS[0]);
  const [vibe, setVibe] = useState('chill');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [group, setGroup] = useState(null);
  const [inviteUrl, setInviteUrl] = useState(null);
  const valid = name.trim().length >= 1 && name.trim().length <= 40;

  function requestClose() {
    if (step < 3 && !window.confirm('Discard this new group?')) return;
    onClose(step === 3);
  }
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;

  // Focus trap, Esc, scroll lock, restore focus.
  useEffect(() => {
    const prev = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const els = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, []);

  // Move focus into the dialog on each step.
  useEffect(() => {
    dialogRef.current?.querySelector('[data-autofocus]')?.focus();
  }, [step]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const g = await api('/api/groups', { method: 'POST', body: { name: name.trim(), emoji, personality: vibe } });
      setGroup(g);
      setStep(3);
      api(`/api/groups/${g.id}`).then((d) => setInviteUrl(d.inviteUrl)).catch(() => setError('Couldn’t load the invite link. Open the group page to find it.'));
    } catch (err) {
      setError(err.status === 400 ? 'Check the group name (1–40 characters).' : err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-pine/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && step < 3 && closeRef.current()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="ngm-title"
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-cloud p-5 shadow-xl sm:max-w-lg sm:rounded-3xl sm:p-7">
        <div className="relative mb-5">
          <Dots step={step} />
          <button type="button" onClick={requestClose} aria-label="Close"
            className="absolute -top-1 right-0 grid h-8 w-8 place-items-center rounded-full text-pine-soft hover:bg-mint-dark">✕</button>
        </div>

        {step === 1 && (
          <form onSubmit={(e) => { e.preventDefault(); if (valid) setStep(2); }}>
            <h2 id="ngm-title" className="text-xl font-bold">Name your group</h2>
            <div className="mt-5">
              <label htmlFor="ngm-name" className={label}>Group name</label>
              <input id="ngm-name" data-autofocus className={input} value={name} maxLength={40}
                onChange={(e) => setName(e.target.value)} placeholder="e.g. Uni Crew Escape" />
              <p className="mt-1 text-right text-xs text-pine-soft" aria-live="polite">{name.length}/40</p>
            </div>
            <div className="mt-3"><EmojiPicker value={emoji} onChange={setEmoji} /></div>
            <button type="submit" disabled={!valid} className={`${btn.base} ${btn.coral} mt-6 w-full`}>Next →</button>
          </form>
        )}

        {step === 2 && (
          <div>
            <h2 id="ngm-title" className="text-xl font-bold">Pick Pact’s vibe</h2>
            <div className="mt-5"><VibePicker value={vibe} onChange={setVibe} autoFocusSelected /></div>
            <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>
            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => { setError(null); setStep(1); }} disabled={saving} className={`${btn.base} ${btn.cloud}`}>Back</button>
              <button type="button" onClick={create} disabled={saving} className={`${btn.base} ${btn.coral} flex-1`}>
                {saving ? 'Creating…' : 'Create group'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && group && (
          <>
            <InviteStep group={group} inviteUrl={inviteUrl} onDone={() => { onClose(true); navigate(`/groups/${group.id}`); }} />
            <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>
          </>
        )}
      </div>
    </div>
  );
}
