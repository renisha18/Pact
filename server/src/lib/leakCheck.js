// Checks AI/user-facing text for leaks of members' private inputs.
// Reasons never include the leaked value so they are safe to log.

const PHRASE_LEN = 4;
const NAME_WINDOW = 3; // words allowed between a name and "budget of"

function tokens(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function ngrams(toks, n) {
  const out = [];
  for (let i = 0; i + n <= toks.length; i++) out.push(toks.slice(i, i + n).join(' '));
  return out;
}

// All numeric values written in the text: "150", "150.00", "$150", "1,500", "15000".
function numbersIn(text) {
  const matches = String(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((m) => Number(m.replace(/,/g, ''))).filter(Number.isFinite);
}

function field(input, snake, camel) {
  return input?.[snake] ?? input?.[camel];
}

function seqIndexes(toks, seq) {
  const idx = [];
  for (let i = 0; i + seq.length <= toks.length; i++) {
    if (seq.every((t, j) => toks[i + j] === t)) idx.push(i);
  }
  return idx;
}

function nameNearBudgetOf(toks, nameToks) {
  if (nameToks.length === 0) return false;
  const budgetAt = seqIndexes(toks, ['budget', 'of']);
  const nameAt = seqIndexes(toks, nameToks);
  return budgetAt.some((b) =>
    nameAt.some((n) => {
      const nameEnd = n + nameToks.length;
      const before = nameEnd <= b && b - nameEnd <= NAME_WINDOW; // "Priya('s) ... budget of"
      const after = n === b + 2; // "budget of Priya"
      return before || after;
    }),
  );
}

/**
 * @param {string} text
 * @param {Array<{ name?: string, display_name?: string, max_budget_cents?: number, maxBudgetCents?: number,
 *   preferences_text?: string, preferencesText?: string, comfort_text?: string, comfortText?: string }>} privateInputs
 * @returns {{ safe: boolean, reason: string | null }}
 */
export function leakCheck(text, privateInputs = []) {
  const textToks = tokens(text);
  const textNums = numbersIn(text);
  const textGrams = new Set(ngrams(textToks, PHRASE_LEN));

  for (const input of privateInputs) {
    const cents = Number(field(input, 'max_budget_cents', 'maxBudgetCents'));
    if (Number.isInteger(cents) && cents > 0) {
      const dollars = cents / 100;
      if (textNums.some((n) => n === dollars || n === cents)) {
        return { safe: false, reason: 'budget_number' };
      }
    }

    for (const src of [
      field(input, 'preferences_text', 'preferencesText'),
      field(input, 'comfort_text', 'comfortText'),
    ]) {
      if (ngrams(tokens(src), PHRASE_LEN).some((g) => textGrams.has(g))) {
        return { safe: false, reason: 'private_phrase' };
      }
    }

    const nameToks = tokens(input?.name ?? input?.display_name ?? input?.displayName);
    if (nameNearBudgetOf(textToks, nameToks)) {
      return { safe: false, reason: 'name_budget' };
    }
  }

  return { safe: true, reason: null };
}
