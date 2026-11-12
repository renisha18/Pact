import './env.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { groupsRouter } from './routes/groups.js';
import { invitesRouter } from './routes/invites.js';
import { tripsRouter } from './routes/trips.js';
import { availabilityRouter } from './routes/availability.js';
import { planningRouter } from './routes/planning.js';
import { commitRouter } from './routes/commit.js';
import { coversRouter } from './routes/covers.js';
import { negotiationsRouter } from './routes/negotiations.js';
import { vocabularyRouter } from './routes/vocabulary.js';
import { demoRouter } from './routes/demo.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { aiMode } from './ai/llm.js';

export const app = express();

app.disable('x-powered-by');
// Behind one hosting proxy in production; locally, don't trust X-Forwarded-For
// (it would let clients spoof IPs and dodge the rate limit).
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});

app.get('/health', (_req, res) => res.json({ ok: true, aiMode: aiMode() }));
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/me', meRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/trips', tripsRouter);
app.use('/api/trips', availabilityRouter);
app.use('/api/trips', planningRouter);
app.use('/api/trips', commitRouter);
app.use('/api/trips', coversRouter);
app.use('/api/trips', negotiationsRouter);
app.use('/api/vocabulary', vocabularyRouter);
app.use('/api/demo', demoRouter);

app.use(notFound);
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const port = 4000;
  app.listen(port, (err) => {
    // Express 5 passes listen errors (e.g. EADDRINUSE) here instead of throwing.
    if (err) {
      console.error(`Pact server could not start on :${port}: ${err.code ?? err.message}`);
      process.exit(1);
    }
    console.log(`Pact server listening on :${port}`);
  });
}

export default app;
