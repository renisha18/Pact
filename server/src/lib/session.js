import jwt from 'jsonwebtoken';

export const SESSION_COOKIE = 'pact_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

export function signSession(userId) {
  return jwt.sign({ sub: String(userId) }, secret(), { algorithm: 'HS256', expiresIn: '7d' });
}

/** Returns the numeric user id, or null if the token is missing/invalid/expired. */
export function verifySession(token) {
  if (!token) return null;
  try {
    const { sub } = jwt.verify(token, secret(), { algorithms: ['HS256'] });
    const id = Number(sub);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function setSessionCookie(res, userId) {
  res.cookie(SESSION_COOKIE, signSession(userId), { ...cookieOptions(), maxAge: MAX_AGE_MS });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}
