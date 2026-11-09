// Private negotiations: when no stay fits everyone, Pact privately asks at most
// two members for one small change each (from counterfactual.js). Rows are
// PRIVATE to their owner. The group only ever sees a generic notice: no
// counts, no names. event_log details stay empty here.
import { writeNegotiationMessage } from '../ai/negotiate.js';

export const MAX_NEGOTIATING_MEMBERS = 2;
export const WORKING_MESSAGE = 'Pact is working something out privately…';
export const EXHAUSTED_MESSAGE = "Pact couldn't find a plan that fits everyone — try changing the trip.";

const DECLINED = ['rejected', 'expired'];
const isBudget = (o) => o.change.kind === 'raiseBudget';
const optionKey = (o) => `${o.change.kind}:${o.change.roomType ?? ''}`;

/** The stored change: everything the owner needs, nothing about anyone else. */
function changeJson(option, alternative, isAlternative) {
  return {
    change: option.change,
    listingId: option.listingId,
    unlockedListingIds: option.unlockedListingIds,
    newShareCents: option.newShareCents,
    matchesOwnWishes: option.matchesOwnWishes,
    alternative: alternative ?? null,
    isAlternative,
  };
}

/** Removes 'preferred' avoids the member agreed to. 'strict' entries are never touched. */
export function applyAllowedRoomTypes(extracted, allowed) {
  if (!extracted || !allowed?.length) return extracted;
  return {
    ...extracted,
    avoidRoomTypes: extracted.avoidRoomTypes.filter(
      (a) => typeof a === 'string' || a.strength !== 'preferred' || !allowed.includes(a.type),
    ),
  };
}

/** Writes one pending negotiation (with its AI/template message). */
export async function insertNegotiation(db, { tripId, userId, option, alternative, isAlternative, ctx }) {
  const listing = ctx.listingsById.get(option.listingId);
  const message = await writeNegotiationMessage({
    personality: ctx.personality,
    ownItems: ctx.extracted.get(userId) ?? { hardRequirements: [], avoidRoomTypes: [], softPreferences: [] },
    option,
    stay: { name: listing.name, area: listing.area },
    otherPrivateInputs: ctx.privateInputs.filter((p) => p.user_id !== userId),
  });
  const { rows: [row] } = await db.query(
    `INSERT INTO negotiations (trip_id, user_id, change_json, message) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tripId, userId, JSON.stringify(changeJson(option, alternative, isAlternative)), message],
  );
  return row.id;
}

/**
 * Called by the planner when nothing fits. Replaces any pending negotiations.
 * @param ctx {{ personality, extracted: Map<userId, tags>, listingsById: Map, privateInputs: rows }}
 * @returns {Promise<{ outcome: 'plan_b', nights: number } | { outcome: 'negotiating' } | { outcome: 'none' | 'exhausted' }>}
 */
export async function openNegotiations(db, tripId, options, ctx) {
  await db.query(`DELETE FROM negotiations WHERE trip_id = $1 AND status = 'pending'`, [tripId]);

  const planB = options.find((o) => o.scope === 'group' && o.change.kind === 'nights');
  if (planB) return { outcome: 'plan_b', nights: planB.change.to };

  // Never re-ask something a member already said no to.
  const { rows: declined } = await db.query(
    `SELECT user_id, change_json FROM negotiations WHERE trip_id = $1 AND status = ANY($2)`,
    [tripId, DECLINED],
  );
  const declinedKeys = new Set(declined.map((d) => `${d.user_id}|${optionKey(d.change_json)}`));

  const perMember = new Map(); // userId -> remaining options, smallest change first
  for (const o of options) {
    if (o.scope !== 'member' || declinedKeys.has(`${o.userId}|${optionKey(o)}`)) continue;
    if (!perMember.has(o.userId)) perMember.set(o.userId, []);
    perMember.get(o.userId).push(o);
  }

  // Every budget option covers the WHOLE shortfall, so at most one member is asked
  // for money: later members get a non-budget ask or are skipped.
  const chosen = [];
  let budgetAsked = false;
  for (const [userId, opts] of perMember) {
    if (chosen.length >= MAX_NEGOTIATING_MEMBERS) break;
    const usable = budgetAsked ? opts.filter((o) => !isBudget(o)) : opts;
    if (usable.length === 0) continue;
    if (isBudget(usable[0])) budgetAsked = true;
    chosen.push([userId, usable]);
  }
  for (const [userId, [option, alternative]] of chosen) {
    await insertNegotiation(db, { tripId, userId, option, alternative, isAlternative: false, ctx });
  }
  if (chosen.length > 0) return { outcome: 'negotiating' };
  return { outcome: declined.length > 0 ? 'exhausted' : 'none' };
}

/** True if someone OTHER than userId has a pending budget ask on this trip. */
export async function otherBudgetAskPending(db, tripId, userId) {
  const { rows } = await db.query(
    `SELECT 1 FROM negotiations
      WHERE trip_id = $1 AND user_id <> $2 AND status = 'pending' AND change_json->'change'->>'kind' = 'raiseBudget'
      LIMIT 1`,
    [tripId, userId],
  );
  return rows.length > 0;
}

/**
 * Group-visible status for a trip with no proposals. Never reveals who or how many.
 * @returns {Promise<{notice: string|null, planB: {nights:number}|null}>}
 */
export async function negotiationNotice(db, tripId) {
  const { rows: [r] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM negotiations WHERE trip_id = $1 AND status = 'pending') AS pending,
            last.action AS last_action, last.details AS last_details
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (
         SELECT action, details FROM event_log
          WHERE trip_id = $1 AND action IN ('plan', 'plan_no_fit', 'plan_b', 'plan_negotiating', 'negotiation_exhausted')
          ORDER BY id DESC LIMIT 1) last ON true`,
    [tripId],
  );
  if (r.pending) return { notice: WORKING_MESSAGE, planB: null };
  if (r.last_action === 'negotiation_exhausted') return { notice: EXHAUSTED_MESSAGE, planB: null };
  if (r.last_action === 'plan_b' && Number.isInteger(r.last_details?.nights)) {
    return { notice: null, planB: { nights: r.last_details.nights } };
  }
  return { notice: null, planB: null };
}
