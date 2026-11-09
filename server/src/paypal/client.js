// The ONLY module that talks to PayPal over HTTP. SANDBOX ONLY: the base URL is
// hard-coded and never read from config.
//
// Rules: never log request/response bodies or tokens. Errors carry PayPal's
// issue code only, never the raw response.
import { randomUUID } from 'node:crypto';

export const PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com';

const TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const ISSUE_RE = /^[A-Z0-9_]{1,80}$/;

export class PayPalError extends Error {
  /**
   * @param {number} status  HTTP status (0 = network/timeout/config)
   * @param {string} issue   PayPal issue code, e.g. "INSTRUMENT_DECLINED", or our own code
   */
  constructor(status, issue) {
    super(`PayPal request failed: ${issue}`);
    this.name = 'PayPalError';
    this.status = status;
    this.issue = issue;
  }
}

/** Pulls only a well-formed issue code out of a PayPal error body. Nothing else is kept. */
function issueFrom(body, status) {
  const candidates = [body?.details?.[0]?.issue, body?.name, body?.error];
  const code = candidates.find((c) => typeof c === 'string' && ISSUE_RE.test(c.toUpperCase()));
  return code ? code.toUpperCase() : `HTTP_${status}`;
}

async function send(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new PayPalError(0, err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  }
}

// --- OAuth token (cached in memory, one in-flight fetch shared by concurrent callers)

let cached = null; // { token, expiresAt }
let inflight = null;

async function fetchToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new PayPalError(0, 'NOT_CONFIGURED');

  const res = await send(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.access_token !== 'string') throw new PayPalError(res.status, issueFrom(body, res.status));

  const ttlMs = Math.max(0, Number(body.expires_in) * 1000 - TOKEN_EXPIRY_MARGIN_MS) || 0;
  cached = { token: body.access_token, expiresAt: Date.now() + ttlMs };
  return cached.token;
}

export async function getAccessToken() {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  inflight ??= fetchToken().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Test helper: forget the cached token. */
export function resetTokenCache() {
  cached = null;
  inflight = null;
}

// --- API helper

/**
 * Calls the PayPal REST API. Every POST gets a PayPal-Request-Id (idempotency key);
 * pass `requestId` to make a retried operation idempotent, otherwise a fresh UUID is used.
 * Returns the parsed JSON body, or null for 204.
 */
export async function api(path, { method = 'GET', body, requestId } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new PayPalError(0, 'INVALID_PATH');

  const idempotencyKey = method === 'POST' ? (requestId ?? randomUUID()) : null;
  const doRequest = async () => {
    const headers = {
      Authorization: `Bearer ${await getAccessToken()}`,
      Accept: 'application/json',
    };
    if (idempotencyKey) {
      headers['PayPal-Request-Id'] = idempotencyKey;
      headers.Prefer = 'return=representation';
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return send(`${PAYPAL_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doRequest();
  if (res.status === 401) {
    // Token revoked or expired early: refresh once. Same PayPal-Request-Id keeps POSTs idempotent.
    cached = null;
    res = await doRequest();
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new PayPalError(res.status, issueFrom(data, res.status));
  return data;
}
