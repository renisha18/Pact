import { query } from '../db.js';
import { HttpError } from './httpError.js';

const notFound = () => new HttpError(404, 'Not found');

/** Parses a route id param; anything that isn't a positive integer is a 404. */
export function parseId(value) {
  if (!/^[1-9]\d{0,9}$/.test(String(value))) throw notFound();
  const id = Number(value);
  if (id > 2147483647) throw notFound();
  return id;
}

/** Returns { groupId, role } or throws 404 (never 403) for non-members. */
export async function assertGroupMember(groupId, userId, db = { query }) {
  const { rows } = await db.query(
    'SELECT group_id, role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId],
  );
  if (rows.length === 0) throw notFound();
  return { groupId: rows[0].group_id, role: rows[0].role };
}

/**
 * Returns the trip row if the user is on the trip and still in its group,
 * otherwise throws 404.
 */
export async function assertTripMember(tripId, userId, db = { query }) {
  const { rows } = await db.query(
    `SELECT t.*, tm.status AS member_status
       FROM trips t
       JOIN trip_members tm ON tm.trip_id = t.id AND tm.user_id = $2
       JOIN group_members gm ON gm.group_id = t.group_id AND gm.user_id = $2
      WHERE t.id = $1`,
    [tripId, userId],
  );
  if (rows.length === 0) throw notFound();
  return rows[0];
}
