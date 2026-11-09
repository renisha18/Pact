import { label } from './ui.jsx';

export const EMOJIS = ['🏝️', '🏄', '🌋', '🌿', '🎒', '🍹', '🐢', '🌅'];
export const VIBES = [
  { value: 'chill', title: 'Chill', line: 'No rush, friends. Whenever you’re ready, I’ll be right here.' },
  { value: 'wholesome', title: 'Wholesome', line: 'You’re all doing amazing! Let’s find a trip everyone will love.' },
  { value: 'savage', title: 'Savage', line: 'Nice try. I know everyone’s secrets and I’m taking them to the grave.' },
];

const radioCard =
  'block h-full rounded-xl bg-mint p-3 ring-1 ring-mint-dark transition peer-checked:bg-white peer-checked:ring-2 peer-checked:ring-coral peer-focus-visible:outline-2 peer-focus-visible:outline-coral peer-disabled:opacity-70';

export function EmojiPicker({ value, onChange, disabled = false, name = 'emoji' }) {
  return (
    <fieldset disabled={disabled}>
      <legend className={label}>Emoji</legend>
      <div className="grid grid-cols-4 gap-2">
        {EMOJIS.map((e) => (
          <label key={e} className={disabled ? '' : 'cursor-pointer'}>
            <input type="radio" name={name} value={e} checked={value === e} onChange={() => onChange(e)} className="peer sr-only" />
            <span className="grid h-12 place-items-center rounded-xl bg-mint text-2xl ring-1 ring-mint-dark transition peer-checked:bg-white peer-checked:ring-2 peer-checked:ring-coral peer-focus-visible:outline-2 peer-focus-visible:outline-coral peer-disabled:opacity-70">{e}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function VibePicker({ value, onChange, disabled = false, autoFocusSelected = false }) {
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">Pact’s vibe</legend>
      <div className="space-y-3">
        {VIBES.map((v) => (
          <label key={v.value} className={`block ${disabled ? '' : 'cursor-pointer'}`}>
            <input type="radio" name="vibe" value={v.value} checked={value === v.value}
              data-autofocus={autoFocusSelected && v.value === value ? true : undefined}
              onChange={() => onChange(v.value)} className="peer sr-only" />
            <span className={radioCard}>
              <span className="block font-bold">{v.title}</span>
              <span className="mt-2 block rounded-xl rounded-tl-none bg-cloud px-3 py-2 text-sm text-pine-soft ring-1 ring-mint-dark">“{v.line}”</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
