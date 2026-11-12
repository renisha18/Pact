// Private negotiations: when no stay fits everyone, Pact privately asks at most
// two members for one small change each (budget: at most two raisers, each for their own amount) (from counterfactual.js). Rows are
// PRIVATE to their owner. The group only ever sees a generic notice: no
// counts, no names. event_log details stay empty here.
import { writeNegotiationMessage } from '../ai/negotiate.js';

export const MAX_NEGOTIATING_MEMBERS = 2;
export const WORKING_MESSAGE = 'Pact is working something out privately…';
export const EXHAUSTED_MESSAGE = "Pact couldn't find a plan that fits everyone — try changing the trip.";

// Only an explicit "no" from the member blocks re-asking. 'expired' = superseded
// (newer plan, or the member edited their input), so it may be asked again.
const DECLINED = ['rejected'];
const isBudget = (o) => o.change.kind === 'raiseBudget';
const groupBy = (xs, key) => xs.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) ?? []), x]), new Map());
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

/** Writes the (AI or template) message for one ask. May call the AI: never inside a DB transaction. */
export async function buildNegotiation({ userId, option, alternative, isAlternative, ctx }) {
  const listing = ctx.listingsById.get(option.listingId);
  const message = await writeNegotiationMessage({
    personality: ctx.personality,
    ownItems: ctx.extracted.get(userId) ?? { hardRequirements: [], avoidRoomTypes: [], softPreferences: [] },
    option,
    stay: { name: listing.name, area: listing.area },
    otherPrivateInputs: ctx.privateInputs.filter((p) => p.user_id !== userId),
  });
  return { userId, changeJson: changeJson(option, alternative, isAlternative), message };
}

/**
 * Inserts one pending ask for plan `version`. The member's private_inputs.updated_at is
 * snapshotted IN SQL (microsecond precision; a JS Date round-trip would lose it).
 */
export async function insertNegotiation(db, tripId, version, built) {
  const { rows: [row] } = await db.query(
    `INSERT INTO negotiations (trip_id, user_id, change_json, message, plan_version, input_updated_at)
     SELECT $1, $2, $3, $4, $5, pi.updated_at
       FROM private_inputs pi WHERE pi.trip_id = $1 AND pi.user_id = $2
     RETURNING id`,
    [tripId, built.userId, JSON.stringify(built.changeJson), built.message, version],
  );
  return row?.id ?? null;
}

/**
 * Called by the planner when nothing fits. Reads only; writes nothing. Messages may
 * call the AI, so run this OUTSIDE any transaction, then save with saveNegotiations.
 * @param ctx {{ personality, extracted: Map<userId, tags>, listingsById: Map, privateInputs: rows }}
 * @returns {Promise<{ outcome: 'plan_b', nights: number } | { outcome: 'negotiating', asks: object[] } |
 *   { outcome: 'none' | 'exhausted' }>}
 */
export async function prepareNegotiations(db, tripId, options, ctx) {
  const planB = options.find((o) => o.scope === 'group' && o.change.kind === 'nights');
  if (planB) return { outcome: 'plan_b', nights: planB.change.to };

  // Never re-ask something a member already said no to.
  const { rows: declined } = await db.query(
    `SELECT user_id, change_json FROM negotiations WHERE trip_id = $1 AND status = ANY($2)`,
    [tripId, DECLINED],
  );
  const declinedKeys = new Set(declined.map((d) => `${d.user_id}|${optionKey(d.change_json)}`));

  // Budget asks come as one unit: every member below the stay's equal share, each asked for
  // exactly their own amount. A unit is skipped if any of its members already said no.
  const isDeclined = (o) => declinedKeys.has(`${o.userId}|${optionKey(o)}`);
  const memberOpts = options.filter((o) => o.scope === 'member');
  const budgetOpts = memberOpts.filter(isBudget);
  const units = [];
  for (const [userId, opts] of groupBy(memberOpts.filter((o) => !isBudget(o) && !isDeclined(o)), (o) => o.userId)) {
    units.push({ members: [userId], opts: new Map([[userId, opts]]), cost: 0, order: units.length });
  }
  if (budgetOpts.length > 0 && !budgetOpts.some(isDeclined)) {
    units.push({ members: budgetOpts.map((o) => o.userId), opts: new Map(budgetOpts.map((o) => [o.userId, [o]])), cost: 1, budget: true });
  }
  // Smallest change first: the options arrive sorted by cost, so rank a unit by its first option's position.
  const rank = (u) => Math.max(...u.members.map((id) => options.findIndex((o) => o.userId === id && (u.budget ? isBudget(o) : !isBudget(o)))));
  units.sort((a, b) => rank(a) - rank(b));

  const chosen = []; // [userId, [option, alternative?]]
  const asked = new Set();
  for (const u of units) {
    if (u.members.some((id) => asked.has(id)) || asked.size + u.members.length > MAX_NEGOTIATING_MEMBERS) continue;
    for (const id of u.members) {
      asked.add(id);
      // Alternatives are never budget asks: those only make sense as a whole group.
      const rest = memberOpts.filter((o) => o.userId === id && !isBudget(o) && !isDeclined(o) && !u.opts.get(id).includes(o));
      chosen.push([id, [...u.opts.get(id), ...rest].slice(0, 2)]);
    }
  }
  if (chosen.length === 0) return { outcome: declined.length > 0 ? 'exhausted' : 'none' };

  const asks = [];
  for (const [userId, [option, alternative]] of chosen) {
    asks.push(await buildNegotiation({ userId, option, alternative, isAlternative: false, ctx }));
  }
  return { outcome: 'negotiating', asks };
}

/** Inside the save transaction: expire every older pending ask, then insert this version's. */
export async function saveNegotiations(client, tripId, version, asks) {
  await client.query(
    `UPDATE negotiations SET status = 'expired' WHERE trip_id = $1 AND status = 'pending' AND plan_version <> $2`,
    [tripId, version],
  );
  for (const built of asks) await insertNegotiation(client, tripId, version, built);
}

/** True if someone OTHER than userId has a pending budget ask on this trip. */
export async function otherBudgetAskPending(db, tripId, userId) {
  const { rows } = await db.query(
    `SELECT 1 FROM negotiations n
       JOIN trips t ON t.id = n.trip_id AND t.active_version = n.plan_version
      WHERE n.trip_id = $1 AND n.user_id <> $2 AND n.status = 'pending'
        AND n.change_json->'change'->>'kind' = 'raiseBudget'
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
    `SELECT EXISTS (SELECT 1 FROM negotiations n JOIN trips t ON t.id = n.trip_id
                     WHERE n.trip_id = $1 AND n.status = 'pending' AND n.plan_version = t.active_version) AS pending,
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
