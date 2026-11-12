import { query } from '../db.js';
import { findUncovered } from '../routes/commit.js';

/**
 * The caller's OWN to-dos across their groups. Every row is scoped to userId;
 * labels never contain other members' names or numbers.
 */
export async function actionsFor(userId) {
  const { rows } = await query(
    `SELECT t.id AS trip_id, t.group_id, t.title AS trip_title, g.name AS group_name, t.status AS trip_status, tm.status AS member_status,
            (t.status IN ('collecting', 'planning')
               AND NOT EXISTS (SELECT 1 FROM private_inputs pi WHERE pi.trip_id = t.id AND pi.user_id = tm.user_id)) AS needs_details,
            (t.status IN ('collecting', 'planning') AND t.dates_status <> 'chosen'
               AND NOT EXISTS (SELECT 1 FROM availability_blocks ab WHERE ab.trip_id = t.id AND ab.user_id = tm.user_id)) AS needs_days,
            (t.status IN ('voting', 'committing') AND t.dates_status = 'chosen' AND t.window_start IS NOT NULL
               AND EXISTS (SELECT 1 FROM availability_blocks ab WHERE ab.trip_id = t.id AND ab.user_id = tm.user_id)
               AND EXISTS (SELECT 1 FROM generate_series(t.start_date, t.end_date, interval '1 day') g(d)
                            WHERE NOT EXISTS (SELECT 1 FROM availability_blocks ab
                                               WHERE ab.trip_id = t.id AND ab.user_id = tm.user_id
                                                 AND g.d::date BETWEEN ab.start_day AND ab.end_day))) AS dates_nudge,
            EXISTS (SELECT 1 FROM negotiations n
                     WHERE n.trip_id = t.id AND n.user_id = tm.user_id AND n.status = 'pending'
                       AND n.plan_version = t.active_version) AS needs_negotiation,
            (t.status = 'voting'
               AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.trip_id = t.id AND v.user_id = tm.user_id)) AS needs_vote,
            (t.status = 'committing' AND tm.status <> 'committed') AS needs_commit,
            (t.status = 'needs_attention' AND COALESCE((
               SELECT p.status = 'failed' FROM payments p
                WHERE p.trip_id = t.id AND p.user_id = tm.user_id AND p.kind IN ('hold', 'payment')
                ORDER BY p.id DESC LIMIT 1), false)) AS payment_failed
       FROM trip_members tm
       JOIN trips t ON t.id = tm.trip_id
       JOIN groups g ON g.id = t.group_id
       JOIN group_members gm ON gm.group_id = t.group_id AND gm.user_id = tm.user_id
      WHERE tm.user_id = $1 AND tm.status <> 'dropped' AND t.status NOT IN ('booked', 'cancelled')
      ORDER BY t.id`,
    [userId],
  );

  const out = [];
  const add = (r, kind, label) => out.push({ groupId: r.group_id, tripId: r.trip_id, tripTitle: r.trip_title, groupName: r.group_name, kind, label });
  for (const r of rows) {
    if (r.needs_days) add(r, 'availability', 'Share the days you can go');
    if (r.dates_nudge) add(r, 'dates_nudge', 'The chosen dates don’t cover all your free days');
    if (r.needs_details) add(r, 'private_details', 'Add your private details');
    if (r.needs_negotiation) add(r, 'negotiation', 'Pact has a private question for you');
    if (r.needs_vote) add(r, 'vote', 'Cast your vote');
    if (r.needs_commit) add(r, 'commit', 'Secure your share');
    if (r.payment_failed) add(r, 'payment_failed', 'Your payment failed — try again');
    if (r.member_status === 'committed' && ['committing', 'needs_attention'].includes(r.trip_status)) {
      const open = await findUncovered({ query }, r.trip_id, userId);
      if (open.length) add(r, 'cover', 'A friend needs more time — you can cover their share');
    }
  }
  return out;
}
