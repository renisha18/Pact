// Equal split. Everyone pays the same share; leftover cents go one each to members in
// ascending userId. All amounts are integer cents. Private budgets never change a share:
// they only decide which stays the group considers (see filterListings).

function assertCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer number of cents`);
  }
}

/**
 * @param {number} totalCents
 * @param {Array<{userId:number}>} members
 * @returns {{shares: Array<{userId:number, amountCents:number}>}} shares in input order
 */
export function equalSplit(totalCents, members) {
  assertCents(totalCents, 'totalCents');
  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError('members must be a non-empty array');
  }
  const seen = new Set();
  for (const m of members) {
    if (seen.has(m.userId)) throw new TypeError(`duplicate userId ${m.userId}`);
    seen.add(m.userId);
  }

  const base = Math.floor(totalCents / members.length);
  let leftover = totalCents - base * members.length;
  const extra = new Set();
  for (const m of [...members].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))) {
    if (leftover === 0) break;
    extra.add(m.userId);
    leftover -= 1;
  }

  const shares = members.map((m) => ({ userId: m.userId, amountCents: base + (extra.has(m.userId) ? 1 : 0) }));
  const sum = shares.reduce((s, x) => s + x.amountCents, 0);
  if (sum !== totalCents) throw new Error(`equalSplit invariant broken: ${sum} !== ${totalCents}`);
  return { shares };
}
