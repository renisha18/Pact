import './env.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
const isProd = process.env.NODE_ENV === 'production';
// In production the SPA is served from this origin, so the CSP must allow the PayPal SDK/popup and Google Fonts.
const PAYPAL = ['https://www.paypal.com', 'https://*.paypal.com', 'https://*.paypalobjects.com'];
app.use(helmet({
  contentSecurityPolicy: isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...PAYPAL],
      frameSrc: PAYPAL,
      connectSrc: ["'self'", ...PAYPAL],
      imgSrc: ["'self'", 'data:', ...PAYPAL],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    },
  } : undefined,
}));
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

app.get('/api/health', (_req, res) => res.json({ ok: true }));
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

// Production: one service serves the built client, with an index.html fallback for deep links.
// Unknown /api paths still get the JSON 404 below.
const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
if (isProd && existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (req, res, next) => {
    // Missing files (e.g. a stale /assets/x.js) stay 404 instead of returning HTML.
    if (req.path === '/api' || req.path.startsWith('/api/') || path.extname(req.path)) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(notFound);
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT) || 4000;
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
