// POST /assist/intent after the end-to-end review: bounded provider calls, the same per-user limit as triage, no provider
// in demo mode, and failure logs that say why without saying anything sensitive. The model is a fake that throws, hangs or
// answers badly; the classifier, route, limiter and logger are the real ones.
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { classifyIntent } from '../src/assist/classifier.js';
import type { IntentClassifier } from '../src/assist/classifiers.js';
import { issueAccessToken, loadSigningKeys } from '../src/identity/access-tokens.js';
import { HttpPaymentProvider } from '../src/payments/provider.js';
import { createDb } from '../src/shared/db.js';
import { IDS } from '../src/shared/seed-data.js';
import { TEST_DB_URL } from './global-setup.js';

const SECRET = 'sk-SECRET-123';
const RESOURCE = 'my-secret-resource';
const CUSTOMER_TEXT = 'my private note about order 98765';
const RAHUL_ORDER = 'bbbbbbbb-0000-4000-8000-000000000001'; // seeded: Rahul's own order
const leaky = `Access denied for key ${SECRET} on ${RESOURCE}`;
const apiError = (statusCode: number | undefined, extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) =>
  new APICallError({ message: leaky, url: `https://${RESOURCE}.openai.azure.com/openai/v1/responses`, requestBodyValues: { input: CUSTOMER_TEXT }, statusCode, responseBody: leaky, isRetryable: false, ...extra });
const usage = { inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const answering = (text: string, finish = 'stop') => new MockLanguageModelV4({ doGenerate: { content: text ? [{ type: 'text', text }] : [], finishReason: { unified: finish as 'stop', raw: finish }, usage, warnings: [] } });
const throwing = (err: unknown) => new MockLanguageModelV4({ doGenerate: async () => { throw err; } });
const hanging = () => new MockLanguageModelV4({ doGenerate: (opts) => new Promise((_res, rej) => { opts.abortSignal?.addEventListener('abort', () => rej(opts.abortSignal?.reason)); }) });

describe('/assist/intent hardening', () => {
  let db: ReturnType<typeof createDb>['db'];
  let keys: Awaited<ReturnType<typeof loadSigningKeys>>;
  beforeAll(async () => {
    const d = createDb(TEST_DB_URL);
    db = d.db; keys = await loadSigningKeys();
    return async () => { await d.pool.end(); };
  });
  const tok = (userId: string, role: 'Customer' | 'RestaurantOwner' | 'Admin', restaurantId?: string) => issueAccessToken(keys, { userId, role, ...(restaurantId ? { restaurantId } : {}) });

  // The REAL classifier wired to a fake model: this is what main.ts builds in live mode, minus the ledger.
  const viaModel = (model: MockLanguageModelV4): IntentClassifier => async (text, opts) => ({ classifier: 'llm', ...(await classifyIntent({ model, providerOptions: {} }, text, opts)) });
  function make(opts: { classify?: IntentClassifier; model?: MockLanguageModelV4; rate?: number; timeoutMs?: number; demo?: boolean } = {}) {
    const lines: string[] = [];
    const app = buildApp({
      db, keys, provider: new HttpPaymentProvider('http://localhost:4010'),
      classify: opts.classify ?? (opts.model ? viaModel(opts.model) : undefined), demo: opts.demo, triageRateLimitPerMin: opts.rate, triageTimeoutMs: opts.timeoutMs,
      logger: { level: 'warn', stream: { write: (l: string) => void lines.push(l) } },
    });
    return { app, log: () => lines.join('') };
  }
  const ask = (app: ReturnType<typeof make>['app'], token: string | undefined, text = 'where is my order') =>
    app.inject({ method: 'POST', url: '/assist/intent', headers: token ? { authorization: `Bearer ${token}` } : {}, payload: { text } });

  describe('a provider that never answers', () => {
    it('is cut off at the timeout: 502 assistant_unavailable within the bound, the model sees the abort, the log says provider_timeout', async () => {
      const model = hanging();
      const { app, log } = make({ model, timeoutMs: 150 });
      const started = Date.now();
      const res = await ask(app, await tok(IDS.rahul, 'Customer'));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'assistant_unavailable' });
      expect(model.doGenerateCalls).toHaveLength(1); // no retry
      expect(model.doGenerateCalls[0]!.abortSignal?.aborted).toBe(true);
      expect(log()).toContain('provider_timeout');
      await app.close();
    });

    it('a caller-side cancel stops the call too, and is logged as aborted, not as a provider failure', async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 60);
      const r = await classifyIntent({ model: hanging(), providerOptions: {} }, 'hi', { abortSignal: ac.signal });
      expect(r).toMatchObject({ outcome: 'provider_error', reason: 'aborted' });
    });
  });

  describe('per-user rate limit (the same limiter and setting as /assist/triage)', () => {
    it('allows the limit, then 429 rate_limited with Retry-After; another user is unaffected', async () => {
      const { app } = make({ model: answering('{"intent":"other"}'), rate: 2 });
      const rahul = await tok(IDS.rahul, 'Customer');
      expect((await ask(app, rahul)).statusCode).toBe(200);
      expect((await ask(app, rahul)).statusCode).toBe(200);
      const limited = await ask(app, rahul);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ error: 'rate_limited' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect((await ask(app, await tok(IDS.aman, 'Customer'))).statusCode).toBe(200);
      await app.close();
    });

    it('requests rejected for authentication or role never use anyone\'s quota', async () => {
      const { app } = make({ model: answering('{"intent":"other"}'), rate: 2 });
      const owner = await tok(IDS.owner, 'RestaurantOwner', IDS.spiceGarden);
      for (let i = 0; i < 6; i++) { await ask(app, undefined); await ask(app, owner); await ask(app, 'not.a.jwt'); }
      const rahul = await tok(IDS.rahul, 'Customer');
      expect([(await ask(app, rahul)).statusCode, (await ask(app, rahul)).statusCode, (await ask(app, rahul)).statusCode]).toEqual([200, 200, 429]);
      await app.close();
    });

    it('triage and intent each have their own quota, and the order-status route (no model) is not limited', async () => {
      const { app } = make({ model: answering('{"intent":"other"}'), rate: 1 });
      const rahul = await tok(IDS.rahul, 'Customer');
      const triage = () => app.inject({ method: 'POST', url: '/assist/triage', headers: { authorization: `Bearer ${rahul}` }, payload: { message: 'hi' } });
      expect((await triage()).statusCode).toBe(503); // no triage model here; it still counts against triage's own quota
      expect((await triage()).statusCode).toBe(429);
      expect((await ask(app, rahul)).statusCode).toBe(200);
      expect((await ask(app, rahul)).statusCode).toBe(429);
      for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: `/assist/order-status?orderId=${RAHUL_ORDER}`, headers: { authorization: `Bearer ${rahul}` } })).statusCode).not.toBe(429);
      await app.close();
    });
  });

  describe('demo mode', () => {
    it('never calls the classifier, even if a real one is injected: the keyword rules answer and the response says simulated', async () => {
      const classify = vi.fn(async () => { throw new Error('a provider must not be called in demo mode'); });
      const { app } = make({ classify: classify as unknown as IntentClassifier, demo: true });
      const res = await ask(app, await tok(IDS.rahul, 'Customer'), 'Please cancel my order');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'ok', classifier: 'rules', simulated: true, intent: 'cancel_order' });
      expect(classify).not.toHaveBeenCalled();
      await app.close();
    });

    it('control: outside demo mode the injected classifier IS used, so the test above is not vacuous', async () => {
      const classify = vi.fn<IntentClassifier>(async () => ({ classifier: 'llm', outcome: 'ok', intent: 'other', usage: { inputTokens: 1, outputTokens: 1 } }));
      const { app } = make({ classify, demo: false });
      const res = await ask(app, await tok(IDS.rahul, 'Customer'));
      expect(res.json()).toMatchObject({ classifier: 'llm', simulated: false });
      expect(classify).toHaveBeenCalledTimes(1);
      await app.close();
    });
  });

  describe('no provider configured', () => {
    it('the keyword rules answer, the response names them, and it is not marked simulated', async () => {
      const { app } = make();
      const res = await ask(app, await tok(IDS.rahul, 'Customer'), 'kya biryani mein pyaaz hota hai?');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ classifier: 'rules', simulated: false });
      await app.close();
    });
  });

  describe('invalid or malformed model output', () => {
    it.each([['not JSON', 'not json at all'], ['wrong label', '{"intent":"pay_me"}'], ['extra field', '{"intent":"other","summary":"x"}'], ['prose', "I can't help with that."], ['empty', '']])('%s: 200 invalid_output, safe fallback, no intent, and the log names a category but not the output', async (_n, text) => {
      const { app, log } = make({ model: answering(text) });
      const res = await ask(app, await tok(IDS.rahul, 'Customer'), CUSTOMER_TEXT);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'invalid_output', next: { action: 'fallback' } });
      expect(res.json().intent).toBeUndefined();
      expect(log()).toContain('invalid_output');
      for (const leak of [text.length > 4 ? text : 'NOPE-NEVER', CUSTOMER_TEXT]) expect(log()).not.toContain(leak);
      await app.close();
    });

    it('a refusal is a refusal: 200 with the fallback, logged as content_filter', async () => {
      const { app, log } = make({ model: answering('', 'content-filter') });
      const res = await ask(app, await tok(IDS.rahul, 'Customer'));
      expect(res.json()).toMatchObject({ outcome: 'refusal', next: { action: 'fallback' } });
      expect(log()).toContain('content_filter');
      await app.close();
    });
  });

  describe('provider errors', () => {
    const CASES: [string, Error, string, number | undefined][] = [
      ['401', apiError(401, { data: { error: { code: 'invalid_api_key', type: 'invalid_request_error' } }, responseHeaders: { 'x-request-id': 'req_abc-1' } }), 'provider_auth', 401],
      ['403', apiError(403), 'provider_auth', 403],
      ['429', apiError(429, { responseHeaders: { 'retry-after': '5' } }), 'provider_rate_limited', 429],
      ['500', apiError(500), 'provider_unavailable', 500],
      ['network failure', apiError(undefined), 'provider_unavailable', undefined],
    ];
    it.each(CASES)('provider %s: 502 assistant_unavailable; the log has the category and status; nothing sensitive; no retry', async (_n, err, code, status) => {
      const model = throwing(err);
      const { app, log } = make({ model });
      const res = await ask(app, await tok(IDS.rahul, 'Customer'), CUSTOMER_TEXT);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'assistant_unavailable' });
      expect(model.doGenerateCalls).toHaveLength(1);
      const l = log();
      expect(l).toContain(code);
      if (status) expect(l).toContain(`"providerStatus":${status}`);
      expect(l).toContain('"route":"/assist/intent"');
      for (const leak of [SECRET, RESOURCE, 'Access denied', CUSTOMER_TEXT, 'openai.azure.com']) { expect(l).not.toContain(leak); expect(res.body).not.toContain(leak); }
      expect(res.body).not.toContain(code); // the client never sees our internal category either
      await app.close();
    });

    it('keeps the identifiers a provider\'s support can use (its error code and request id), and only if they look like identifiers', async () => {
      const { app, log } = make({ model: throwing(CASES[0]![1]) });
      await ask(app, await tok(IDS.rahul, 'Customer'));
      expect(log()).toContain('invalid_api_key');
      expect(log()).toContain('req_abc-1');
      await app.close();
    });

    it('an error that is not a provider failure is logged as unexpected_error and is still a safe 502, not a stack trace', async () => {
      const { app, log } = make({ model: throwing(new TypeError('boom internal detail')) });
      const res = await ask(app, await tok(IDS.rahul, 'Customer'));
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'assistant_unavailable' });
      expect(log()).toContain('unexpected_error');
      expect(log()).not.toContain('boom internal detail');
      await app.close();
    });
  });
});
