import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { selfUser } from '../lib/views.js';

import { actionsFor } from '../lib/actions.js';

export const meRouter = Router();

meRouter.get('/', requireAuth, (req, res) => {
  res.json(selfUser(req.user));
});

meRouter.get('/actions', requireAuth, async (req, res) => {
  res.json(await actionsFor(req.user.id));
});
