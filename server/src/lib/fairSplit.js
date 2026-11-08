// Water-filling fair split. All amounts are integer cents.
// Members whose cap is below the equal share pay exactly their cap; everyone
// else splits the rest equally. Leftover cents go one each to uncapped
// members in ascending userId. Shares are returned in input order.

function assertCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer number of cents`);
  }
}

export function fairSplit(totalCents, members) {
  assertCents(totalCents, 'totalCents');
  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError('members must be a non-empty array');
  }
  const seen = new Set();
  for (const m of members) {
    assertCents(m.capCents, 'capCents');
    if (seen.has(m.userId)) throw new TypeError(`duplicate userId ${m.userId}`);
    seen.add(m.userId);
  }

  const capSum = members.reduce((sum, m) => sum + m.capCents, 0);
  if (capSum < totalCents) return { feasible: false };

  const amounts = new Map();
  let uncapped = [...members];
  let remaining = totalCents;

  // Cap anyone who can't afford the current equal share, until stable.
  // Compare cap * n < remaining to avoid fractional division.
  for (;;) {
    const n = uncapped.length;
    const below = uncapped.filter((m) => m.capCents * n < remaining);
    if (below.length === 0) break;
    for (const m of below) {
      amounts.set(m.userId, m.capCents);
      remaining -= m.capCents;
    }
    uncapped = uncapped.filter((m) => !below.includes(m));
  }

  // capSum >= total guarantees uncapped is non-empty when remaining > 0.
  if (uncapped.length > 0) {
    const base = Math.floor(remaining / uncapped.length);
    let leftover = remaining - base * uncapped.length;
    const byId = [...uncapped].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    for (const m of byId) {
      amounts.set(m.userId, base + (leftover > 0 ? 1 : 0));
      if (leftover > 0) leftover -= 1;
    }
  }

  const shares = members.map((m) => ({ userId: m.userId, amountCents: amounts.get(m.userId) }));
  const sum = shares.reduce((s, x) => s + x.amountCents, 0);
  if (sum !== totalCents) throw new Error(`fairSplit invariant broken: ${sum} !== ${totalCents}`);
  for (const [i, s] of shares.entries()) {
    if (s.amountCents > members[i].capCents) throw new Error('fairSplit invariant broken: share exceeds cap');
  }
  return { feasible: true, shares };
}
