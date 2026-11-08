/** 'YYYY-MM-DD' → local Date at midnight (no timezone shift). */
export function parseDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatDate(isoDate, opts = { month: 'short', day: 'numeric' }) {
  return parseDate(isoDate).toLocaleDateString(undefined, opts);
}

export function formatRange(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  const sameYear = s.getFullYear() === e.getFullYear();
  const startStr = s.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  const endStr = e.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

/** Today as 'YYYY-MM-DD' in the user's local timezone. */
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Only allow same-origin relative paths as redirect targets. */
export function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/';
}
