import { ZodError } from 'zod';

export function notFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  // body-parser errors (malformed JSON, payload too large) carry status + expose.
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) {
    // Log message (and stack outside production) but never request bodies.
    console.error(process.env.NODE_ENV === 'production' ? err.message : err.stack);
  }
  const body = { error: status < 500 && err.expose ? err.message : 'Internal server error' };
  if (process.env.NODE_ENV !== 'production' && status >= 500) body.stack = err.stack;
  res.status(status).json(body);
}
