// F-3 (rate limit), F-5 (client disconnect) and F-6 (status codes) for POST /assist/chat, end to end with the real database
// and a scripted model. A scripted model is a stand-in: it proves how the server behaves, not how a live provider behaves.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOOP } from '../src/assist/agent-loop.js';
import { BudgetLedger } from '../src/assist/budget.js';
import { FALLBACK } from '../src/assist/templates.js';
import { memoryAudit } from '../src/assist/tools/audit.js';
import { OrdersService } from '../src/orders/service.js';
import { present, scripted, type Step } from './fake-model.js';
import { startStack } from './helpers.js';

const model = scripted([]);
const use = (steps: Step[]) => { const inner = scripted(steps); model.doGenerate = (opts) => inner.doGenerate(opts); };
const mkAssistant = (over: Partial<typeof DEFAULT_LOOP> = {}) => ({
  model, providerOptions: {}, audit: memoryAudit(),
  ledger: new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'chatf-')), 'usage.json'), 5),
  config: { ...DEFAULT_LOOP, ...over, priceKey: 'azure:gpt-5.4-mini', maxOutputTokens: 400, turnBudgetUsd: 0.05, estimateMargin: 1.25 },
});
const SECRET = 'SECRET-provider-text sk-LEAK-CANARY my-resource.openai.azure.com';
const apiErr = (statusCode: number, headers: Record<string, string> = {}) =>
  new APICallError({ message: SECRET, url: `https://${SECRET}/x`, requestBodyValues: { prompt: SECRET }, statusCode, responseHeaders: headers, responseBody: SECRET });

afterEach(() => vi.restoreAllMocks());

describe('F-6: a failed turn is a non-2xx with a machine-readable code, and still carries the fixed fallback', () => {
  let stack: Awaited<ReturnType<typeof startStack>>;
  let token: string;
  beforeAll(async () => { stack = await startStack({ assistant: mkAssistant() }); token = (await stack.login('rahul@tadka.test')).accessToken; });
  const chat = (text = 'where is my order?') => stack.app.inject({ method: 'POST', url: '/assist/chat', payload: { text }, headers: { authorization: `Bearer ${token}` } });

  it('a successful turn is 200 with exactly { answer, stopReason, steps }', async () => {
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }]);
    const res = await chat();
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['answer', 'steps', 'stopReason']);
  });

  it.each([
    ['provider 429 (with Retry-After)', apiErr(429, { 'retry-after': '7' }), 429, 'provider_rate_limited', '7'],
    ['provider 401 (our credentials)', apiErr(401), 502, 'provider_auth', undefined],
    ['provider 500', apiErr(500), 502, 'provider_unavailable', undefined],
    ['provider 503', apiErr(503), 502, 'provider_unavailable', undefined],
    ['provider timeout', Object.assign(new Error(SECRET), { name: 'TimeoutError' }), 504, 'provider_timeout', undefined],
  ])('%s -> %i %s', async (_n, err, status, code, retryAfter) => {
    use([{ calls: [], throws: err }]);
    const res = await chat();
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code, answer: FALLBACK, stopReason: expect.any(String), steps: [] });
    expect(res.headers['retry-after']).toBe(retryAfter);
    expect(res.body).not.toMatch(/SECRET|sk-LEAK|my-resource|openai\.azure\.com/); // nothing from the provider reaches the client
  });

  it('the model answering in prose (twice) is 502 provider_bad_output; the model looping is 502 too', async () => {
    use([{ text: 'Sure! Here is your order: it is on the way.' }]);
    const a = await chat();
    expect(a.statusCode).toBe(502);
    expect(a.json()).toMatchObject({ error: 'provider_bad_output', answer: FALLBACK });
    expect(a.body).not.toMatch(/on the way/); // the model's prose is never shown
    use(Array.from({ length: 8 }, () => ({ calls: [['get_my_orders', {}] as [string, unknown]] })));
    expect((await chat()).statusCode).toBe(502);
  });

  it('a database failure during the tool is a 503 backend_unavailable with the fixed sentence, not a 200', async () => {
    vi.spyOn(OrdersService.prototype, 'listRecent').mockRejectedValue(new Error('connection terminated: SECRET db host'));
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }]);
    const res = await chat();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'backend_unavailable', stopReason: 'answered', steps: [{ tool: 'get_my_orders', status: 'failed' }] });
    expect(res.json().answer).toMatch(/couldn't fetch that right now/);
    expect(res.body).not.toMatch(/SECRET|connection terminated/);
  });

  it('the spending cap is a 503 budget_exhausted', async () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'chatf2-')), 'usage.json'), 0.0000001);
    const capped = await startStack({ assistant: { ...mkAssistant(), ledger } });
    const res = await capped.app.inject({ method: 'POST', url: '/assist/chat', payload: { text: 'hi' }, headers: { authorization: `Bearer ${(await capped.login('rahul@tadka.test')).accessToken}` } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'budget_exhausted', answer: FALLBACK });
  });
});

describe('F-3: /assist/chat is rate limited per verified user, like the other model-spending routes', () => {
  it('the limit is per user: the 4th request in a minute is 429 rate_limited with Retry-After; another user is unaffected; requests refused for authentication or role use no quota', async () => {
    const stack = await startStack({ assistant: mkAssistant(), rateLimitPerMin: 3 });
    const rahul = (await stack.login('rahul@tadka.test')).accessToken;
    const aman = (await stack.login('aman@tadka.test')).accessToken;
    const owner = (await stack.login('owner@tadka.test')).accessToken;
    const post = (token: string | undefined, payload: unknown = { text: 'hi' }) =>
      stack.app.inject({ method: 'POST', url: '/assist/chat', payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }]);
    // requests refused for authentication or role before the limiter counts them: no token, an owner
    for (let i = 0; i < 6; i++) expect((await post(undefined)).statusCode).toBe(401);
    for (let i = 0; i < 6; i++) expect((await post(owner)).statusCode).toBe(403);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) { use([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }]); codes.push((await post(rahul)).statusCode); }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await post(rahul);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }]);
    expect((await post(aman)).statusCode).toBe(200);
  });

  it('a limited request never reaches the provider', async () => {
    const stack = await startStack({ assistant: mkAssistant(), rateLimitPerMin: 1 });
    const token = (await stack.login('rahul@tadka.test')).accessToken;
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }]);
    const post = () => stack.app.inject({ method: 'POST', url: '/assist/chat', payload: { text: 'hi' }, headers: { authorization: `Bearer ${token}` } });
    expect((await post()).statusCode).toBe(200);
    const spy = vi.spyOn(model, 'doGenerate');
    expect((await post()).statusCode).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('F-5: the turn stops when the client disconnects', () => {
  it('an aborted HTTP request abandons the provider call at once; the estimate is charged and nothing stays held', async () => {
    const assistant = mkAssistant({ deadlineMs: 20_000 });
    const stack = await startStack({ assistant });
    const token = (await stack.login('rahul@tadka.test')).accessToken;
    const address = await stack.app.listen({ port: 0, host: '127.0.0.1' });
    use([{ calls: [present('r1')], delayMs: 15_000 }]); // the "provider" is slow
    const ctl = new AbortController();
    const started = Date.now();
    const p = fetch(`${address}/assist/chat`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ text: 'hi' }) }).catch((e) => e);
    await vi.waitFor(() => expect(assistant.ledger.read().reservations?.some((r) => r.state === 'sent')).toBe(true), { timeout: 5000 });
    ctl.abort();
    expect((await p).name).toBe('AbortError');
    // The turn ends within a moment (not at the 20 s deadline): its reservation is settled at the estimate.
    await vi.waitFor(() => expect(assistant.ledger.read().reservations?.every((r) => r.state === 'settled')).toBe(true), { timeout: 4000 });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(assistant.ledger.ambiguous()).toEqual([]);
    expect(assistant.ledger.spent()).toBeGreaterThan(0);
  }, 30_000);
});

describe('demo mode never reaches a provider (F-1 for /assist/chat)', () => {
  it('DEMO_MODE with an assistant passed in: 503 assistant_not_configured and the model is never called', async () => {
    const stack = await startStack({ assistant: mkAssistant(), demo: true });
    const token = (await stack.login('rahul@tadka.test')).accessToken;
    const spy = vi.spyOn(model, 'doGenerate');
    const res = await stack.app.inject({ method: 'POST', url: '/assist/chat', payload: { text: 'hi' }, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'assistant_not_configured' });
    expect(spy).not.toHaveBeenCalled();
  });
});
