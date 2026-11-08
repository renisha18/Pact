import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { selfUser } from '../lib/views.js';

export const meRouter = Router();

meRouter.get('/', requireAuth, (req, res) => {
  res.json(selfUser(req.user));
});
