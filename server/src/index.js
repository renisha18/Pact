import './env.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

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

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/me', meRouter);

app.use(notFound);
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const port = 4000;
  app.listen(port, () => console.log(`Pact server listening on :${port}`));
}

export default app;
