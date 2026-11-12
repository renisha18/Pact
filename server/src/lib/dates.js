// Flexible trip dates: plain code, no AI. Days are 'YYYY-MM-DD' strings.
const DAY_MS = 86_400_000;

export const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

/** Every day from start to end, inclusive. */
export function windowDays(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Candidate trips of `nights` nights inside the window: each needs nights+1 calendar days
 * (arrival through departure). `availability` is Map<userId, Set<day>>.
 * Returns [{ startDate, endDate, availableCount, total }] in date order.
 */
export function candidateRuns(windowStart, windowEnd, nights, availability) {
  const total = availability.size;
  const out = [];
  for (let s = windowStart; daysBetween(s, windowEnd) >= nights; s = addDays(s, 1)) {
    const span = Array.from({ length: nights + 1 }, (_, i) => addDays(s, i));
    let availableCount = 0;
    for (const days of availability.values()) if (span.every((d) => days.has(d))) availableCount += 1;
    out.push({ startDate: s, endDate: addDays(s, nights), availableCount, total });
  }
  return out;
}

/**
 * Earliest run where everyone is available -> { kind: 'full', startDate, endDate }.
 * Otherwise the top 3 windows by available-member COUNT (ties: earlier first) -> { kind: 'fallback', options }.
 * Options carry counts only: never member ids or names.
 */
export function chooseDates(windowStart, windowEnd, nights, availability) {
  const runs = candidateRuns(windowStart, windowEnd, nights, availability);
  const full = runs.find((r) => r.availableCount === r.total);
  if (full) return { kind: 'full', startDate: full.startDate, endDate: full.endDate };
  const options = [...runs]
    .sort((a, b) => b.availableCount - a.availableCount || a.startDate.localeCompare(b.startDate))
    .slice(0, 3)
    .map(({ startDate, endDate, availableCount, total }) => ({ startDate, endDate, availableCount, total }));
  return { kind: 'fallback', options };
}

/** Blocks [{startDate, endDate}] -> Set of every calendar day they cover (inclusive). */
export function expandBlocks(blocks) {
  const days = new Set();
  for (const b of blocks) for (const d of windowDays(b.startDate, b.endDate)) days.add(d);
  return days;
}
