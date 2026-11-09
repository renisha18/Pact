import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, PayPalError, PAYPAL_BASE_URL, resetTokenCache } from '../src/paypal/client.js';
import {
  centsToUsd, createAuthorizeOrder, captureAuthorization, voidAuthorization, getOrder,
} from '../src/paypal/orders.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const tokenRes = () => json(200, { access_token: 'tok', expires_in: 3600 });

let fetchMock;
beforeEach(() => {
  resetTokenCache();
  vi.stubEnv('PAYPAL_CLIENT_ID', 'id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('centsToUsd', () => {
  it('formats integer cents', () => {
    expect(centsToUsd(1234)).toBe('12.34');
    expect(centsToUsd(5)).toBe('0.05');
    expect(centsToUsd(100000)).toBe('1000.00');
  });
  it('rejects non-integers, zero and negatives', () => {
    for (const bad of [0, -1, 12.5, '100', NaN, null]) expect(() => centsToUsd(bad)).toThrow(PayPalError);
  });
});

describe('paypal client', () => {
  it('uses the sandbox, caches the token, adds PayPal-Request-Id on POST only', async () => {
    fetchMock.mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(201, { id: 'O1' }))
      .mockResolvedValueOnce(json(200, { id: 'O1' }));

    await createAuthorizeOrder(1234, 'trip-1-user-2');
    await getOrder('O1');

    expect(fetchMock).toHaveBeenCalledTimes(3); // one token fetch
    for (const [url] of fetchMock.mock.calls) expect(url.startsWith(PAYPAL_BASE_URL)).toBe(true);
    expect(PAYPAL_BASE_URL).toContain('sandbox');

    const [, post] = fetchMock.mock.calls[1];
    expect(post.headers['PayPal-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(post.body)).toEqual({
      intent: 'AUTHORIZE',
      purchase_units: [{ amount: { currency_code: 'USD', value: '12.34' }, custom_id: 'trip-1-user-2' }],
    });
    const [, get] = fetchMock.mock.calls[2];
    expect(get.headers['PayPal-Request-Id']).toBeUndefined();
  });

  it('throws only the issue code', async () => {
    fetchMock.mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(
      json(422, { name: 'UNPROCESSABLE_ENTITY', message: 'secret detail', details: [{ issue: 'AUTHORIZATION_VOIDED', description: 'x' }] }),
    );
    const err = await captureAuthorization('A1', 500).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.issue).toBe('AUTHORIZATION_VOIDED');
    expect(err.status).toBe(422);
    expect(err.message).not.toContain('secret detail');
  });

  it('refreshes the token once on 401 and keeps the same request id', async () => {
    fetchMock.mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });
    expect(await voidAuthorization('A1')).toBeNull();
    expect(fetchMock.mock.calls[1][1].headers['PayPal-Request-Id']).toBe(fetchMock.mock.calls[3][1].headers['PayPal-Request-Id']);
  });

  it('rejects path-unsafe ids and missing config', async () => {
    await expect(getOrder('../v1/x')).rejects.toMatchObject({ issue: 'INVALID_ID' });
    vi.stubEnv('PAYPAL_CLIENT_ID', '');
    await expect(api('/v2/checkout/orders/O1')).rejects.toMatchObject({ issue: 'NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
