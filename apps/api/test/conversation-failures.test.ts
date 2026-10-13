// EP3 + EP2 remediation: POST /assist/conversations/:id/messages spends model tokens on every turn, so it gets the same
// protections as /assist/chat: a per-user limit (429), the turn is abandoned when the client disconnects (and nothing is
// stored), and a turn that did not answer is a non-2xx with a machine-readable code. Scripted model: server behaviour only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOOP } from '../src/assist/agent-loop.js';
import { BudgetLedger } from '../src/assist/budget.js';
import { FALLBACK } from '../src/assist/templates.js';
import { memoryAudit } from '../src/assist/tools/audit.js';
import { present, scripted, type Step } from './fake-model.js';
import { startStack } from './helpers.js';

const model = scripted([]);
const use = (steps: Step[]) => { const inner = scripted(steps); model.doGenerate = (opts) => inner.doGenerate(opts); };
const mkAssistant = (over: Partial<typeof DEFAULT_LOOP> = {}) => ({
  model, providerOptions: {}, audit: memoryAudit(),
  ledger: new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'convf-')), 'usage.json'), 5),
  config: { ...DEFAULT_LOOP, ...over, priceKey: 'azure:gpt-5.4-mini', maxOutputTokens: 400, turnBudgetUsd: 0.05, estimateMargin: 1.25 },
});
const SECRET = 'SECRET-provider-text sk-LEAK-CANARY';
const apiErr = (statusCode: number) => new APICallError({ message: SECRET, url: `https://${SECRET}/x`, requestBodyValues: {}, statusCode, responseBody: SECRET });

afterEach(() => vi.restoreAllMocks());

async function setup(opts: Parameters<typeof startStack>[0] = {}) {
  const stack = await startStack({ assistant: mkAssistant(), ...opts });
  const token = (await stack.login('rahul@tadka.test')).accessToken;
  const as = (t: string, r: { method: 'GET' | 'POST'; url: string; payload?: object }) => stack.app.inject({ ...r, headers: { authorization: `Bearer ${t}` } });
  const open = async (t = token) => (await as(t, { method: 'POST', url: '/assist/conversations' })).json().conversationId as string;
  const say = (id: string, text = 'where is my order?', t = token) => as(t, { method: 'POST', url: `/assist/conversations/${id}/messages`, payload: { text } });
  const turnsOf = async (id: string) => (await as(token, { method: 'GET', url: `/assist/conversations/${id}` })).json();
  return { stack, token, as, open, say, turnsOf };
}

describe('F-6 in a conversation: a failed turn is a non-2xx with a code, the fallback, and no provider text', () => {
  it.each([
    ['provider 500', apiErr(500), 502, 'provider_unavailable'],
    ['provider 429', apiErr(429), 429, 'provider_rate_limited'],
    ['provider timeout', Object.assign(new Error(SECRET), { name: 'TimeoutError' }), 504, 'provider_timeout'],
  ])('%s -> %i %s', async (_n, err, status, code) => {
    const t = await setup();
    const id = await t.open();
    use([{ calls: [], throws: err }]);
    const res = await t.say(id);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code, answer: FALLBACK, steps: [] });
    expect(res.body).not.toMatch(/SECRET|sk-LEAK/);
  });

  it('prose twice is 502 provider_bad_output; a successful turn is still 200 with its context', async () => {
    const t = await setup();
    const id = await t.open();
    use([{ text: 'Sure, it is on the way.' }]);
    const bad = await t.say(id);
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toBe('provider_bad_output');
    expect(bad.body).not.toMatch(/on the way/);
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('t2r1')] }]);
    const ok = await t.say(id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ stopReason: 'answered', context: { turnsSent: expect.any(Number) } });
  });

  it('the failed turn is still recorded in the conversation (what the customer saw), so a follow-up can continue', async () => {
    const t = await setup();
    const id = await t.open();
    use([{ calls: [], throws: apiErr(500) }]);
    expect((await t.say(id)).statusCode).toBe(502);
    const history = await t.turnsOf(id);
    expect(JSON.stringify(history)).toContain('provider_error');
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('t2r1')] }]);
    expect((await t.say(id, 'try again')).statusCode).toBe(200);
  });

  it('the spending cap is a 503 budget_exhausted', async () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'convf2-')), 'usage.json'), 0.0000001);
    const t = await setup({ assistant: { ...mkAssistant(), ledger } });
    const res = await t.say(await t.open());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'budget_exhausted', answer: FALLBACK });
  });
});

describe('F-3 in a conversation: the same per-user limit', () => {
  it('the limit is per user (the 3rd request in a minute is 429 with Retry-After), 401/403 use no quota, a limited turn never reaches the provider', async () => {
    const t = await setup({ rateLimitPerMin: 2 });
    const aman = (await t.stack.login('aman@tadka.test')).accessToken;
    const owner = (await t.stack.login('owner@tadka.test')).accessToken;
    const id = await t.open();
    for (let i = 0; i < 5; i++) expect((await t.stack.app.inject({ method: 'POST', url: `/assist/conversations/${id}/messages`, payload: { text: 'x' } })).statusCode).toBe(401);
    for (let i = 0; i < 5; i++) expect((await t.say(id, 'x', owner)).statusCode).toBe(403);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) { use([{ calls: [['get_my_orders', {}]] }, { calls: [present(`t${i + 1}r1`)] }]); codes.push((await t.say(id, `q${i}`)).statusCode); }
    expect(codes).toEqual([200, 200, 429, 429]);
    const limited = await t.say(id);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const spy = vi.spyOn(model, 'doGenerate');
    await t.say(id);
    expect(spy).not.toHaveBeenCalled();
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('t1r1')] }]);
    expect((await t.say(await t.open(aman), 'hi', aman)).statusCode).toBe(200);
  });
});

describe('F-5 in a conversation: client disconnect abandons the turn and stores nothing', () => {
  it('an aborted HTTP request ends the turn within seconds, charges the estimate, and the conversation is unchanged', async () => {
    const assistant = mkAssistant({ deadlineMs: 20_000 });
    const t = await setup({ assistant });
    const address = await t.stack.app.listen({ port: 0, host: '127.0.0.1' });
    const id = await t.open();
    use([{ calls: [present('t1r1')], delayMs: 15_000 }]);
    const ctl = new AbortController();
    const p = fetch(`${address}/assist/conversations/${id}/messages`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}` }, body: JSON.stringify({ text: 'hi' }) }).catch((e) => e);
    await vi.waitFor(() => expect(assistant.ledger.read().reservations?.some((r) => r.state === 'sent')).toBe(true), { timeout: 5000 });
    ctl.abort();
    expect((await p).name).toBe('AbortError');
    await vi.waitFor(() => expect(assistant.ledger.read().reservations?.every((r) => r.state === 'settled')).toBe(true), { timeout: 4000 });
    expect(assistant.ledger.ambiguous()).toEqual([]);
    // nothing was stored: the next turn is turn 1 again
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('t1r1')] }]);
    const next = await t.say(id, 'again');
    expect(next.statusCode).toBe(200);
    expect(next.json().context).toMatchObject({ turnsSent: 0 });
  }, 30_000);
});

describe('demo mode never reaches a provider in a conversation either', () => {
  it('503 assistant_not_configured and the model is never called', async () => {
    const t = await setup({ demo: true });
    const id = await t.open();
    const spy = vi.spyOn(model, 'doGenerate');
    const res = await t.say(id);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'assistant_not_configured' });
    expect(spy).not.toHaveBeenCalled();
  });
});
