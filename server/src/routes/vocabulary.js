import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { loadVocabulary } from '../ai/extract.js';
import { vocabularyView } from '../lib/chips.js';

export const vocabularyRouter = Router();
vocabularyRouter.use(requireAuth);

// Public listing vocabulary (no member data): only values that exist in listings.
vocabularyRouter.get('/', async (_req, res) => {
  res.json(vocabularyView(await loadVocabulary()));
});
