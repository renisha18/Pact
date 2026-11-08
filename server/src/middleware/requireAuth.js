import { query } from '../db.js';
import { SESSION_COOKIE, verifySession, clearSessionCookie } from '../lib/session.js';

export async function requireAuth(req, res, next) {
  const userId = verifySession(req.cookies?.[SESSION_COOKIE]);
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const { rows } = await query(
    'SELECT id, name, email, avatar_emoji, paypal_sandbox_email FROM users WHERE id = $1',
    [userId],
  );
  if (rows.length === 0) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Not logged in' });
  }
  req.user = rows[0];
  next();
}
