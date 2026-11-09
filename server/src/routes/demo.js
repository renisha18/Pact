// Demo helpers, available only when DEMO_MODE=true (otherwise 404, as if absent).
// Reset wipes EVERY table and rebuilds the demo scenario, so it is organizer-only.
import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { query } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../lib/validate.js';
import { HttpError } from '../lib/httpError.js';
import { resetDemo } from '../../db/demoScenario.js';

export const demoRouter = Router();
demoRouter.use(requireAuth);

const demoMode = () => process.env.DEMO_MODE === 'true';
const isOrganizer = async (userId) =>
  (await query(`SELECT 1 FROM group_members WHERE user_id = $1 AND role = 'organizer' LIMIT 1`, [userId])).rows.length > 0;

const resetLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  keyGenerator: (req) => `user:${req.user.id}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many resets, slow down' },
});

// Tells the client whether to show the Reset button. Never errors when demo mode is off.
demoRouter.get('/status', async (req, res) => {
  res.json({ canReset: demoMode() && (await isOrganizer(req.user.id)) });
});

demoRouter.post('/reset', resetLimiter, validateBody(z.strictObject({})), async (req, res) => {
  if (!demoMode()) throw new HttpError(404, 'Not found');
  if (!(await isOrganizer(req.user.id))) throw new HttpError(403, 'Only the organizer can do that');
  const { groupId, tripId } = await resetDemo();
  // Same seed order -> same user ids, so everyone's session keeps working.
  res.json({ groupId, tripId });
});
