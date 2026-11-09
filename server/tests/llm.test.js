import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const generateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI() {
    this.models = { generateContent };
  }),
}));

const { generateJson, generateText, AiError, aiMode, __resetClientForTests } = await import('../src/ai/llm.js');

const schema = z.object({ pick: z.number().int() });
const reply = (text) => Promise.resolve({ text });

describe('llm', () => {
  beforeEach(() => {
    generateContent.mockReset();
    __resetClientForTests();
    vi.stubEnv('AI_API_KEY', 'test-key');
    vi.stubEnv('AI_MODEL', 'test-model');
    vi.stubEnv('AI_MODE', 'live');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('requests JSON with the system prompt and model, and validates the result', async () => {
    generateContent.mockReturnValueOnce(reply('{"pick": 3}'));
    await expect(generateJson('SYS', { a: 1 }, schema)).resolves.toEqual({ pick: 3 });
    const req = generateContent.mock.calls[0][0];
    expect(req.model).toBe('test-model');
    expect(req.contents).toBe('{"a":1}');
    expect(req.config.systemInstruction).toBe('SYS');
    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('accepts fenced JSON', async () => {
    generateContent.mockReturnValueOnce(reply('```json\n{"pick": 1}\n```'));
    await expect(generateJson('S', 'u', schema)).resolves.toEqual({ pick: 1 });
  });

  it('retries once on invalid JSON, then succeeds', async () => {
    generateContent.mockReturnValueOnce(reply('not json')).mockReturnValueOnce(reply('{"pick": 2}'));
    await expect(generateJson('S', 'u', schema)).resolves.toEqual({ pick: 2 });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[1][0].config.systemInstruction).toMatch(/not valid JSON/);
  });

  it('retries once on schema mismatch, then throws invalid_output', async () => {
    generateContent.mockReturnValue(reply('{"pick": "three"}'));
    const err = await generateJson('S', 'u', schema).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('invalid_output');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('times out after 20s with a clean error', async () => {
    vi.useFakeTimers();
    generateContent.mockReturnValue(new Promise(() => {}));
    const p = generateText('S', 'u').catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await p;
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('timeout');
    expect(generateContent.mock.calls[0][0].config.abortSignal.aborted).toBe(true);
  });

  it('hides upstream error messages (they may echo inputs)', async () => {
    generateContent.mockRejectedValue(Object.assign(new Error('bad request: SECRET-INPUT'), { status: 400 }));
    const err = await generateText('S', 'SECRET-INPUT').catch((e) => e);
    expect(err.code).toBe('upstream');
    expect(err.message).toBe('AI request failed (status 400)');
    expect(err.message).not.toMatch(/SECRET/);
  });

  const busy = (status) => Promise.reject(Object.assign(new Error('busy'), { status }));

  it.each([500, 503])('retries once after a %s busy error', async (status) => {
    vi.useFakeTimers();
    generateContent.mockReturnValueOnce(busy(status)).mockReturnValueOnce(reply('ok'));
    const p = generateText('S', 'u');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBe('ok');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  const quotaError = (quotaId) =>
    Object.assign(
      new Error(
        `got status: 429. {"error":{"message":"quota exceeded for SECRET-INPUT","details":[{"violations":[{"quotaMetric":"m","quotaId":"${quotaId}"}]}]}}`,
      ),
      { status: 429 },
    );

  it.each([
    ['GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'daily'],
    ['GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'per_minute'],
  ])('does not retry a 429 and reports only the quota name (%s)', async (quotaId, kind) => {
    generateContent.mockImplementation(() => Promise.reject(quotaError(quotaId)));
    const err = await generateText('S', 'SECRET-INPUT').catch((e) => e);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('rate_limited');
    expect(err.quota).toBe(kind);
    expect(err.quotaId).toBe(quotaId);
    expect(err.message).toBe(`AI quota exceeded (${kind})`);
    expect(JSON.stringify({ ...err, message: err.message })).not.toMatch(/SECRET/);
  });

  it('reports an unknown quota when the 429 has no quota id', async () => {
    generateContent.mockImplementation(() => busy(429));
    const err = await generateText('S', 'u').catch((e) => e);
    expect(err.code).toBe('rate_limited');
    expect(err.quota).toBe('unknown');
    expect(err.quotaId).toBeNull();
  });

  it('gives up after one busy retry', async () => {
    vi.useFakeTimers();
    generateContent.mockImplementation(() => busy(503));
    const p = generateText('S', 'u').catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await p;
    expect(err.code).toBe('upstream');
    expect(err.message).toBe('AI request failed (status 503)');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-busy errors like 400 or 404', async () => {
    for (const status of [400, 404]) {
      generateContent.mockReset();
      generateContent.mockImplementation(() => busy(status));
      expect((await generateText('S', 'u').catch((e) => e)).code).toBe('upstream');
      expect(generateContent).toHaveBeenCalledTimes(1);
    }
  });

  it('skips the busy retry when the 20s budget is nearly spent', async () => {
    vi.useFakeTimers();
    generateContent.mockImplementationOnce(
      () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('busy'), { status: 503 })), 17_000)),
    );
    const p = generateText('S', 'u').catch((e) => e);
    await vi.advanceTimersByTimeAsync(17_000);
    expect((await p).code).toBe('upstream');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('busy retries share the 20s budget with the first attempt', async () => {
    vi.useFakeTimers();
    generateContent
      .mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('busy'), { status: 503 })), 10_000)))
      .mockImplementationOnce(() => new Promise(() => {}));
    const p = generateText('S', 'u').catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await p).code).toBe('timeout');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('throws not_configured without a key', async () => {
    vi.stubEnv('AI_API_KEY', '');
    const err = await generateText('S', 'u').catch((e) => e);
    expect(err.code).toBe('not_configured');
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('generateText returns trimmed text', async () => {
    generateContent.mockReturnValueOnce(reply('  hello  \n'));
    await expect(generateText('S', 'u')).resolves.toBe('hello');
    expect(generateContent.mock.calls[0][0].config.responseMimeType).toBeUndefined();
  });

  describe('AI_MODE', () => {
    it('defaults to mock outside production and live in production', () => {
      vi.stubEnv('AI_MODE', '');
      vi.stubEnv('NODE_ENV', 'development');
      expect(aiMode()).toBe('mock');
      vi.stubEnv('NODE_ENV', 'production');
      expect(aiMode()).toBe('live');
    });

    it('mock mode returns canned, schema-valid replies without calling the API or needing a key', async () => {
      vi.stubEnv('AI_MODE', 'mock');
      vi.stubEnv('AI_API_KEY', '');
      const picks = z.object({ picks: z.array(z.object({ listingId: z.number(), reason: z.string() })).min(1).max(3) });
      const out = await generateJson('S', '<stays>[{"listingId":7},{"listingId":9},{"listingId":7}]</stays>', picks, { task: 'pick' });
      expect(out.picks.map((p) => p.listingId)).toEqual([7, 9]);

      const tags = z.object({ features: z.array(z.string()), avoidRoomTypes: z.array(z.string()) });
      await expect(generateJson('S', 'u', tags, { task: 'extract' })).resolves.toEqual({ features: [], avoidRoomTypes: [] });
      await expect(generateText('S', 'u', { task: 'ask' })).resolves.toMatch(/mock mode/);
      expect(generateContent).not.toHaveBeenCalled();
    });

    it('mock mode fails cleanly for unknown tasks or schema mismatch', async () => {
      vi.stubEnv('AI_MODE', 'mock');
      expect((await generateJson('S', 'u', schema).catch((e) => e)).code).toBe('invalid_output');
      expect((await generateJson('S', 'u', schema, { task: 'extract' }).catch((e) => e)).code).toBe('invalid_output');
    });
  });

  it('only src/ai/llm.js imports the LLM SDK, and src/ai never logs', async () => {
    const root = new URL('../src/', import.meta.url).pathname;
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const src = await readFile(join(root, f), 'utf8');
      if (f !== join('ai', 'llm.js')) expect(src, f).not.toMatch(/@google\/genai/);
      if (f.startsWith(`ai${'/'}`)) expect(src, f).not.toMatch(/console\./);
    }
  });
});
