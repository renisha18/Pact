// Empty VITE_API_URL (production, same origin) means relative /api URLs. Unset in dev falls back to the local server.
const API_URL = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '')).replace(/\/+$/, '');

export const AI_UNAVAILABLE_MESSAGE = 'Pact is catching its breath — try again in a minute';

export class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** True when the AI planner/chat is down or out of quota (show a calm retry note, not an error). */
  get aiUnavailable() {
    return this.code === 'ai_unavailable';
  }
}

/** fetch wrapper: sends the session cookie, JSON in/out, throws ApiError on non-2xx. */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (data?.code === 'ai_unavailable') throw new ApiError(res.status, AI_UNAVAILABLE_MESSAGE, data.code);
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code ?? null);
  }
  return data;
}
