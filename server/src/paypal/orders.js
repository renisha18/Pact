// PayPal Orders v2 + Payments v2 wrappers. Amounts in are integer cents (computed
// by the server, never by the client or AI); amounts out to PayPal are "12.34" USD strings.
import { api, PayPalError } from './client.js';

const MAX_CENTS = 1_000_000_00; // $1,000,000 sanity ceiling
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CUSTOM_ID_RE = /^[\x20-\x7E]{1,127}$/; // PayPal custom_id: up to 127 chars

/** Integer cents → "12.34". Throws on anything that isn't a positive integer. */
export function centsToUsd(amountCents) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_CENTS) {
    throw new PayPalError(0, 'INVALID_AMOUNT');
  }
  return `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`;
}

const usd = (amountCents) => ({ currency_code: 'USD', value: centsToUsd(amountCents) });

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PayPalError(0, 'INVALID_ID');
  return id;
}

function checkCustomId(customId) {
  const s = String(customId);
  if (!CUSTOM_ID_RE.test(s)) throw new PayPalError(0, 'INVALID_CUSTOM_ID');
  return s;
}

async function createOrder(intent, amountCents, customId, opts) {
  return api('/v2/checkout/orders', {
    method: 'POST',
    requestId: opts?.requestId,
    body: {
      intent,
      purchase_units: [{ amount: usd(amountCents), custom_id: checkCustomId(customId) }],
    },
  });
}

// --- Orders

/** Order the buyer approves now; funds are held (authorized) and captured later. */
export const createAuthorizeOrder = async (amountCents, customId, opts) =>
  createOrder('AUTHORIZE', amountCents, customId, opts);

/** Order captured immediately after buyer approval. */
export const createCaptureOrder = async (amountCents, customId, opts) =>
  createOrder('CAPTURE', amountCents, customId, opts);

export const getOrder = async (id) => api(`/v2/checkout/orders/${checkId(id)}`);

export const authorizeOrder = async (id, opts) =>
  api(`/v2/checkout/orders/${checkId(id)}/authorize`, { method: 'POST', body: {}, requestId: opts?.requestId });

export const captureOrder = async (id, opts) =>
  api(`/v2/checkout/orders/${checkId(id)}/capture`, { method: 'POST', body: {}, requestId: opts?.requestId });

// --- Authorizations

export const getAuthorization = async (id) => api(`/v2/payments/authorizations/${checkId(id)}`);

export const captureAuthorization = async (id, amountCents, opts) =>
  api(`/v2/payments/authorizations/${checkId(id)}/capture`, {
    method: 'POST',
    requestId: opts?.requestId,
    body: { amount: usd(amountCents), final_capture: true },
  });

/** Releases the hold. PayPal returns 204 → resolves to null. */
export const voidAuthorization = async (id, opts) =>
  api(`/v2/payments/authorizations/${checkId(id)}/void`, { method: 'POST', requestId: opts?.requestId });

// --- Captures

/** Full refund of a capture. */
export const refundCapture = async (captureId, opts) =>
  api(`/v2/payments/captures/${checkId(captureId)}/refund`, { method: 'POST', body: {}, requestId: opts?.requestId });
