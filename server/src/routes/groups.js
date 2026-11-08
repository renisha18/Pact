import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { assertGroupMember, parseId } from '../lib/membership.js';
import {
  groupSummary, groupDetail, groupMember, tripSummary, tripPublic, inviteUrl,
} from '../lib/views.js';

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

groupsRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT g.id, g.name, g.emoji,
            (SELECT count(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
            nt.id AS next_trip_id, nt.title AS next_trip_title,
            nt.status AS next_trip_status, nt.start_date AS next_trip_start_date
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
       LEFT JOIN LATERAL (
         SELECT t.id, t.title, t.status, t.start_date
           FROM trips t
          WHERE t.group_id = g.id AND t.status <> 'cancelled' AND t.start_date >= CURRENT_DATE
          ORDER BY t.start_date, t.id
          LIMIT 1
       ) nt ON true
      ORDER BY g.created_at DESC, g.id DESC`,
    [req.user.id],
  );
  res.json(rows.map(groupSummary));
});

const createGroupSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  emoji: z.string().trim().min(1).max(16).default('🏝️'),
  personality: z.enum(['chill', 'wholesome', 'savage']).default('chill'),
});

groupsRouter.post('/', validateBody(createGroupSchema), async (req, res) => {
  const { name, emoji, personality } = req.body;
  const group = await withTransaction(async (client) => {
    const { rows: [g] } = await client.query(
      `INSERT INTO groups (name, emoji, personality, invite_token, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, emoji, personality, created_at`,
      [name, emoji, personality, randomBytes(24).toString('base64url'), req.user.id],
    );
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'organizer')`,
      [g.id, req.user.id],
    );
    return g;
  });
  res.status(201).json(groupDetail(group));
});

groupsRouter.get('/:id', async (req, res) => {
  const groupId = parseId(req.params.id);
  await assertGroupMember(groupId, req.user.id);

  const [groupRes, membersRes, tripsRes] = await Promise.all([
    query(
      'SELECT id, name, emoji, personality, invite_token, created_at FROM groups WHERE id = $1',
      [groupId],
    ),
    query(
      `SELECT u.id, u.name, u.avatar_emoji, gm.role, gm.fun_title
         FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1
        ORDER BY (gm.role = 'organizer') DESC, gm.joined_at, u.id`,
      [groupId],
    ),
    query(
      `SELECT id, title, status, start_date, end_date
         FROM trips WHERE group_id = $1
        ORDER BY start_date DESC, id DESC`,
      [groupId],
    ),
  ]);

  const group = groupRes.rows[0];
  res.json({
    group: groupDetail(group),
    members: membersRes.rows.map(groupMember),
    trips: tripsRes.rows.map(tripSummary),
    inviteUrl: inviteUrl(group.invite_token),
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = z.iso.date();

const createTripSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(120),
    startDate: isoDate,
    endDate: isoDate,
  })
  .transform((v, ctx) => {
    const nights = Math.round((Date.parse(v.endDate) - Date.parse(v.startDate)) / DAY_MS);
    if (!(nights >= 1 && nights <= 60)) {
      ctx.addIssue({ code: 'custom', message: 'Trip must be 1-60 nights', path: ['endDate'] });
      return z.NEVER;
    }
    return { ...v, nights };
  });

// Membership is checked before the body so non-members always get a plain 404.
async function requireGroupMember(req, _res, next) {
  req.groupId = parseId(req.params.id);
  await assertGroupMember(req.groupId, req.user.id);
  next();
}

groupsRouter.post('/:id/trips', requireGroupMember, validateBody(createTripSchema), async (req, res) => {
  const { groupId } = req;
  const { title, startDate, endDate, nights } = req.body;

  const trip = await withTransaction(async (client) => {
    const { rows: [t] } = await client.query(
      `INSERT INTO trips (group_id, title, region, start_date, end_date, nights, created_by)
       VALUES ($1, $2, 'Bali', $3, $4, $5, $6)
       RETURNING *`,
      [groupId, title, startDate, endDate, nights, req.user.id],
    );
    await client.query(
      `INSERT INTO trip_members (trip_id, user_id, status)
       SELECT $1, gm.user_id, 'invited' FROM group_members gm WHERE gm.group_id = $2`,
      [t.id, groupId],
    );
    return t;
  });
  res.status(201).json(tripPublic(trip));
});
