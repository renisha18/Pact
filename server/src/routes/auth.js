import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { publicUser } from '../lib/views.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { setSessionCookie, clearSessionCookie } from '../lib/session.js';

export const authRouter = Router();

authRouter.get('/demo-users', async (_req, res) => {
  const { rows } = await query('SELECT id, name, avatar_emoji FROM users ORDER BY id');
  res.json(rows.map(publicUser));
});

const demoLoginSchema = z.strictObject({ userId: z.number().int().positive() });

authRouter.post('/demo-login', validateBody(demoLoginSchema), async (req, res) => {
  const { rows } = await query('SELECT id, name, avatar_emoji FROM users WHERE id = $1', [req.body.userId]);
  if (rows.length === 0) throw new HttpError(404, 'User not found');
  setSessionCookie(res, rows[0].id);
  res.json(publicUser(rows[0]));
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});
