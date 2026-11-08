import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { HttpError } from '../lib/httpError.js';
import { invitePreview } from '../lib/views.js';

export const invitesRouter = Router();
invitesRouter.use(requireAuth);

// 24 random bytes as base64url = 32 chars.
function parseToken(token) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new HttpError(404, 'Not found');
  return token;
}

invitesRouter.get('/:token', async (req, res) => {
  const token = parseToken(req.params.token);
  const { rows } = await query(
    `SELECT g.name, g.emoji,
            (SELECT count(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
       FROM groups g WHERE g.invite_token = $1`,
    [token],
  );
  if (rows.length === 0) throw new HttpError(404, 'Not found');
  res.json(invitePreview(rows[0]));
});

invitesRouter.post('/:token/join', async (req, res) => {
  const token = parseToken(req.params.token);
  const groupId = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id FROM groups WHERE invite_token = $1', [token]);
    if (rows.length === 0) throw new HttpError(404, 'Not found');
    const id = rows[0].id;
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [id, req.user.id],
    );
    await client.query(
      `INSERT INTO trip_members (trip_id, user_id, status)
       SELECT t.id, $2, 'invited' FROM trips t
        WHERE t.group_id = $1 AND t.status = 'collecting'
       ON CONFLICT (trip_id, user_id) DO NOTHING`,
      [id, req.user.id],
    );
    return id;
  });
  res.json({ groupId });
});
