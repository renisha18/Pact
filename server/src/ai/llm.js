// The ONLY module that talks to the LLM. Every other AI file must call
// generateJson / generateText from here.
//
// Rules: never log prompts, inputs or outputs; never call PayPal; never compute
// money. Errors thrown from here carry a code and a generic message only.
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const TIMEOUT_MS = 20_000; // total budget per call, including the busy retry
// 429 is NOT retried: retrying an exhausted quota only burns more of it.
const BUSY_STATUSES = new Set([500, 503]);
const BUSY_RETRY_DELAY_MS = 1_000;
const MIN_RETRY_BUDGET_MS = 3_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AiError extends Error {
  /**
   * @param {'not_configured'|'timeout'|'invalid_output'|'upstream'|'rate_limited'} code
   * @param {string} message  generic; never contains request or response content
   * @param {{ quota?: 'daily'|'per_minute'|'unknown', quotaId?: string|null }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    if (extra.quota) {
      this.quota = extra.quota;
      this.quotaId = extra.quotaId ?? null;
    }
  }
}

/** "mock" = canned responses, no API calls. "live" = Gemini. Default: mock outside production. */
export function aiMode() {
  const mode = process.env.AI_MODE;
  if (mode === 'mock' || mode === 'live') return mode;
  return process.env.NODE_ENV === 'production' ? 'live' : 'mock';
}

// Quota ids are provider identifiers like "GenerateRequestsPerDayPerProjectPerModel-FreeTier".
// Only this strict pattern is pulled out of the upstream error; nothing else from it is kept.
const QUOTA_ID_RE = /"quotaId"\s*:\s*"([A-Za-z0-9_.-]{1,120})"/g;

/** Which quota a 429 hit. Returns only the quota id and its kind, never other error text. */
export function classifyQuota(err) {
  const ids = [...String(err?.message ?? '').matchAll(QUOTA_ID_RE)].map((m) => m[1]);
  const daily = ids.find((id) => /PerDay/i.test(id));
  const minute = ids.find((id) => /PerMinute/i.test(id));
  if (daily) return { quota: 'daily', quotaId: daily };
  if (minute) return { quota: 'per_minute', quotaId: minute };
  return { quota: 'unknown', quotaId: ids[0] ?? null };
}

let client;
function getClient() {
  if (!process.env.AI_API_KEY || !process.env.AI_MODEL) {
    throw new AiError('not_configured', 'AI is not configured');
  }
  client ??= new GoogleGenAI({ apiKey: process.env.AI_API_KEY });
  return client;
}

const toText = (content) => (typeof content === 'string' ? content : JSON.stringify(content));

async function callModel(systemPrompt, userContent, extraConfig = {}) {
  const ai = getClient();
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiError('timeout', 'AI request timed out'));
    }, TIMEOUT_MS);
  });

  const deadline = Date.now() + TIMEOUT_MS;
  const send = () => {
    const request = ai.models.generateContent({
      model: process.env.AI_MODEL,
      contents: toText(userContent),
      config: {
        systemInstruction: systemPrompt,
        abortSignal: controller.signal,
        httpOptions: { timeout: Math.max(1, deadline - Date.now()) },
        ...extraConfig,
      },
    });
    request.catch(() => {}); // avoid unhandled rejection if the timeout wins
    return Promise.race([request, timeout]);
  };

  try {
    let response;
    try {
      response = await send();
    } catch (err) {
      // One quick retry when Gemini says it's busy, if the 20s budget allows.
      if (err instanceof AiError || !BUSY_STATUSES.has(err?.status)) throw err;
      if (deadline - Date.now() < BUSY_RETRY_DELAY_MS + MIN_RETRY_BUDGET_MS) throw err;
      await Promise.race([sleep(BUSY_RETRY_DELAY_MS), timeout]);
      response = await send();
    }
    const text = response?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new AiError('invalid_output', 'AI returned an empty response');
    }
    return text;
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (controller.signal.aborted) throw new AiError('timeout', 'AI request timed out');
    if (err?.status === 429) {
      const q = classifyQuota(err);
      throw new AiError('rate_limited', `AI quota exceeded (${q.quota})`, q);
    }
    // Deliberately drop the upstream message: it can echo request content.
    const status = Number.isInteger(err?.status) ? ` (status ${err.status})` : '';
    throw new AiError('upstream', `AI request failed${status}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  // Tolerate a ```json fenced block even though we ask for raw JSON.
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

const RETRY_NOTE =
  '\n\nIMPORTANT: Your previous reply was not valid JSON matching the required shape. ' +
  'Reply with ONLY a single JSON value that matches it exactly. No prose, no code fences.';

// --- Mock mode: canned, schema-valid responses keyed by task. No network.

const MOCK_REASONS = [
  'A comfy, easygoing pick that works for the whole crew.',
  'Solid all-rounder with plenty of room to hang out together.',
  'Fun spot with good vibes and space for everyone.',
];

const MOCK_JSON = {
  extract: () => ({ hardRequirements: [], avoidRoomTypes: [], preferredAvoidRoomTypes: [], softPreferences: [] }),
  pick: (content) => {
    const ids = [...new Set([...content.matchAll(/"listingId":(\d+)/g)].map((m) => Number(m[1])))];
    return { picks: ids.slice(0, 3).map((listingId, i) => ({ listingId, reason: MOCK_REASONS[i] })) };
  },
  reason: () => ({ reason: MOCK_REASONS[0] }),
};

const MOCK_TEXT = {
  negotiate: () => 'Tiny idea from Pact: one small tweak on your side could open up a stay the whole crew would love.',
  ask: () => "I'm in mock mode, so I'm just vibing right now. Ask me again when the real me wakes up!",
};

function mockResponse(table, task, userContent) {
  const make = table[task];
  if (!make) throw new AiError('invalid_output', 'No mock response for this task');
  return make(toText(userContent));
}

/**
 * Asks for JSON, validates it with zodSchema, retries once on invalid JSON or
 * schema mismatch. Returns the parsed (zod-validated) value.
 * @param {{ task?: 'extract'|'pick'|'reason' }} [options]  task picks the canned reply in mock mode
 */
export async function generateJson(systemPrompt, userContent, zodSchema, { task } = {}) {
  if (!(zodSchema instanceof z.ZodType)) throw new TypeError('generateJson needs a zod schema');

  if (aiMode() === 'mock') {
    const parsed = zodSchema.safeParse(mockResponse(MOCK_JSON, task, userContent));
    if (!parsed.success) throw new AiError('invalid_output', 'Mock response did not match the schema');
    return parsed.data;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1 ? systemPrompt : systemPrompt + RETRY_NOTE;
    const text = await callModel(prompt, userContent, { responseMimeType: 'application/json' });
    let value;
    try {
      value = parseJson(text);
    } catch {
      continue;
    }
    const parsed = zodSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  throw new AiError('invalid_output', 'AI returned invalid output');
}

/**
 * Plain text generation with the same timeout and error handling.
 * @param {{ task?: 'ask' }} [options]  task picks the canned reply in mock mode
 */
export async function generateText(systemPrompt, userContent, { task } = {}) {
  if (aiMode() === 'mock') return mockResponse(MOCK_TEXT, task, userContent);
  return (await callModel(systemPrompt, userContent)).trim();
}

/** Test hook: drop the cached client so env changes take effect. */
export function __resetClientForTests() {
  client = undefined;
}
