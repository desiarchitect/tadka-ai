import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, isCancelled, resolveApiBaseUrl } from '../src/api/client.js';
import type { ApiDiagnostics } from '../src/api/types.js';

const res = (status: number, body: unknown, ok = status >= 200 && status < 300) => ({
  ok, status, statusText: String(status), headers: new Headers({ 'x-request-id': 'r1', 'x-trace-id': 't1' }),
  json: async () => { if (body === undefined) throw new SyntaxError('not json'); return body; },
});
const okTriage = { output: { intent: 'other', language: 'en', needsHuman: false, summary: 's' }, simulated: false, modelId: 'm' };
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as (Error & { diagnostics: ApiDiagnostics }) | null;
const hangingFetch = () => vi.fn((_url: string, init: RequestInit) => new Promise((_res, rej) => {
  init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
}));

afterEach(() => vi.restoreAllMocks());

describe('ApiClient', () => {
  it('times out: the request is aborted and reported as client_timeout, not as a network error', async () => {
    const f = hangingFetch();
    globalThis.fetch = f as unknown as typeof fetch;
    const err = await failure(new ApiClient('http://x', 60).triage('hi', 'tok'));
    expect(err?.diagnostics.errorCode).toBe('client_timeout');
    expect(err?.message).toMatch(/No answer within/);
    expect((f.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('a caller cancel is a cancellation, distinct from a timeout and from an error', async () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    const ac = new AbortController();
    const p = new ApiClient('http://x', 5000).triage('hi', 'tok', ac.signal);
    ac.abort();
    const err = await p.then(() => null, (e: unknown) => e);
    expect(isCancelled(err)).toBe(true);
  });

  it('an already-cancelled signal sends nothing', async () => {
    const f = hangingFetch();
    globalThis.fetch = f as unknown as typeof fetch;
    const ac = new AbortController();
    ac.abort();
    expect(isCancelled(await new ApiClient('http://x').triage('hi', 'tok', ac.signal).then(() => null, (e: unknown) => e))).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('a network failure is network_error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    expect((await failure(new ApiClient('http://x').triage('hi', 'tok')))?.diagnostics.errorCode).toBe('network_error');
  });

  it.each([
    ['missing output', { modelId: 'x', simulated: false }],
    ['unknown intent', { ...okTriage, output: { ...okTriage.output, intent: 'pay_me' } }],
    ['no simulated flag', { output: okTriage.output, modelId: 'm' }],
    ['not an object', 'oops'],
    ['not JSON', undefined],
  ])('a 200 with a bad body (%s) is invalid_response', async (_n, body) => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, body));
    const err = await failure(new ApiClient('http://x').triage('hi', 'tok'));
    expect(err?.diagnostics.errorCode).toBe('invalid_response');
  });

  it('a login response without an access token is invalid_response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, { refreshToken: 'r', expiresIn: 1 }));
    expect((await failure(new ApiClient('http://x').login('a@b.c', 'p')))?.diagnostics.errorCode).toBe('invalid_response');
  });

  it('server error text is never shown: the message is the client\'s own wording for the code', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(502, { error: 'provider_unavailable', detail: 'sk-SECRET resource my-secret' }));
    const err = await failure(new ApiClient('http://x').triage('hi', 'tok'));
    expect(err?.message).not.toMatch(/SECRET|my-secret|provider_unavailable/);
    expect(err?.diagnostics.errorCode).toBe('provider_unavailable');
  });

  it.each([
    [403, 'forbidden_role', /Only customer accounts/],
    [429, 'rate_limited', /Too many requests/],
    [503, 'provider_not_configured', /No AI model is configured/],
    [504, 'provider_timeout', /took too long/],
    [429, 'provider_rate_limited', /provider is busy/],
    [401, 'invalid_token', /Authentication required/],
  ])('%i %s has its own message', async (status, code, message) => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(status, { error: code }, false));
    const err = await failure(new ApiClient('http://x').triage('hi', 'tok'));
    expect(err?.message).toMatch(message);
    expect(err?.diagnostics.errorCode).toBe(code);
  });

  it('an error response that is not JSON still yields a usable error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(500, undefined, false));
    expect((await failure(new ApiClient('http://x').triage('hi', 'tok')))?.diagnostics.errorCode).toBe('http_500');
  });

  it('sends the token only when there is one', async () => {
    const f = vi.fn().mockResolvedValue(res(200, okTriage));
    globalThis.fetch = f;
    await new ApiClient('http://x/').triage('hi', null);
    await new ApiClient('http://x/').triage('hi', 'tok');
    expect(((f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect(((f.mock.calls[1]![1] as RequestInit).headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(f.mock.calls[0]![0]).toBe('http://x/assist/triage');
  });
});

describe('ApiClient product calls', () => {
  const order = { id: 'o1', restaurantId: 'r1', status: 'Placed', totalPaise: 100, version: 1, createdAt: '2026-10-01T00:00:00Z' };

  it('GET calls send no body and no Content-Type; the token goes in the Authorization header', async () => {
    const f = vi.fn().mockResolvedValue(res(200, []));
    globalThis.fetch = f;
    await new ApiClient('http://x').orders('tok');
    await new ApiClient('http://x').restaurants();
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://x/orders');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
    expect((f.mock.calls[1]![1] as RequestInit).headers).toEqual({});
  });

  it('ids are encoded into the path, so an odd id cannot change which route is called', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ...order, items: [] }));
    globalThis.fetch = f;
    await new ApiClient('http://x').order('a/../b?x=1', 'tok');
    expect(f.mock.calls[0]![0]).toBe('http://x/orders/a%2F..%2Fb%3Fx%3D1');
  });

  it('responses are validated: an order with an unknown status, or a list that is not a list, is invalid_response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, [{ ...order, status: 'Teleported' }]));
    expect((await failure(new ApiClient('http://x').orders('t')))?.diagnostics.errorCode).toBe('invalid_response');
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, { not: 'a list' }));
    expect((await failure(new ApiClient('http://x').restaurants()))?.diagnostics.errorCode).toBe('invalid_response');
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, { restaurant: { id: 'r', name: 'n', city: 'c' }, items: [{ id: 'i', restaurantId: 'r', name: 'x', pricePaise: 1.5 }] }));
    expect((await failure(new ApiClient('http://x').menu('r')))?.diagnostics.errorCode).toBe('invalid_response');
  });

  it('unknown extra fields are dropped, nothing is invented: the menu has name and price only', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, { restaurant: { id: 'r', name: 'n', city: 'c' }, items: [{ id: 'i', restaurantId: 'r', name: 'x', pricePaise: 100, vegetarian: true }] }));
    const out = await new ApiClient('http://x').menu('r');
    expect(Object.keys(out.data.items[0]!).sort()).toEqual(['id', 'name', 'pricePaise', 'restaurantId']);
  });

  it.each([
    [409, 'order_is_Preparing', /now Preparing and can no longer be paid/],
    [409, 'cannot_move_Delivered_to_Confirmed', /now Delivered/],
    [409, 'order_changed_concurrently', /changed while you were paying/],
    [402, 'payment_declined', /declined\. You were not charged/],
    [502, 'payment_outcome_unknown', /could not confirm the payment/],
    [404, 'order_not_found', /could not be found/],
    [401, 'invalid_token', /session has ended/],
  ])('pay: %i %s has its own wording', async (status, code, message) => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(status, { error: code }, false));
    const err = await failure(new ApiClient('http://x').pay('o1', 'tok'));
    expect(err?.message).toMatch(message);
    expect(err?.message).not.toContain(code);
    expect(err?.diagnostics.httpStatus).toBe(status);
  });

  it('pay sends a POST with the token to the order\'s pay path', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ...order, status: 'Confirmed' }));
    globalThis.fetch = f;
    const out = await new ApiClient('http://x').pay('o1', 'tok');
    expect(out.data.status).toBe('Confirmed');
    expect(f.mock.calls[0]![0]).toBe('http://x/orders/o1/pay');
    expect((f.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });

  it('logout accepts the 204 with no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, statusText: 'No Content', headers: new Headers(), json: async () => { throw new SyntaxError('empty'); } });
    await expect(new ApiClient('http://x').logout('refresh')).resolves.toMatchObject({ data: null });
  });
});

describe('ApiClient EP-1 calls', () => {
  const ok = { outcome: 'ok', classifier: 'rules', simulated: false, intent: 'other', next: { action: 'clarify', message: 'm' } };

  it('intent sends only { text } and the token, and keeps the classifier and simulated flags', async () => {
    const f = vi.fn().mockResolvedValue(res(200, ok));
    globalThis.fetch = f;
    const out = await new ApiClient('http://x').intent('hello', 'tok');
    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({ text: 'hello' });
    expect(f.mock.calls[0]![0]).toBe('http://x/assist/intent');
    expect(out.data.classifier).toBe('rules');
    expect(out.diagnostics.simulated).toBe(false);
  });

  it('intent responses are validated: an unknown next-step action, an unknown intent or a missing classifier is invalid_response', async () => {
    for (const bad of [{ ...ok, next: { action: 'refund_now', message: 'x' } }, { ...ok, intent: 'pay_me' }, { outcome: 'ok', simulated: false, next: ok.next }]) {
      globalThis.fetch = vi.fn().mockResolvedValue(res(200, bad));
      expect((await failure(new ApiClient('http://x').intent('hi', 't')))?.diagnostics.errorCode).toBe('invalid_response');
    }
  });

  it('a non-ok outcome with no intent is accepted as such (nothing is invented)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, { outcome: 'invalid_output', classifier: 'llm', simulated: false, next: { action: 'fallback', message: 'm' } }));
    const out = await new ApiClient('http://x').intent('hi', 't');
    expect(out.data.intent).toBeUndefined();
  });

  it.each([
    [403, 'customers_only', /Only customer accounts/],
    [502, 'assistant_unavailable', /classifier could not answer/],
    [429, 'rate_limited', /Too many requests/],
  ])('intent %i %s has its own wording and never shows the code', async (status, code, message) => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(status, { error: code }, false));
    const err = await failure(new ApiClient('http://x').intent('hi', 't'));
    expect(err?.message).toMatch(message);
    expect(err?.message).not.toContain(code);
  });

  it('orderStatus is a GET with the order id encoded into the query', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { orderId: 'a', status: 'Preparing' }));
    globalThis.fetch = f;
    await new ApiClient('http://x').orderStatus('a&b=1', 'tok');
    expect(f.mock.calls[0]![0]).toBe('http://x/assist/order-status?orderId=a%26b%3D1');
    expect((f.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });
});

describe('ApiClient EP-2 chat', () => {
  const ok = { answer: 'a', stopReason: 'answered', steps: [{ tool: 'get_order', status: 'ok' }] };
  const resH = (status: number, body: unknown, headers: Record<string, string>) => ({ ...res(status, body), headers: new Headers({ 'x-request-id': 'r', ...headers }) });

  it('sends only { text } and the token; a 200 is validated (unknown step status, missing steps: invalid_response)', async () => {
    const f = vi.fn().mockResolvedValue(res(200, ok));
    globalThis.fetch = f;
    const out = await new ApiClient('http://x').chat('where is my order?', 'tok');
    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({ text: 'where is my order?' });
    expect(f.mock.calls[0]![0]).toBe('http://x/assist/chat');
    expect(out.data.steps).toEqual([{ tool: 'get_order', status: 'ok' }]);
    for (const bad of [{ ...ok, steps: [{ tool: 't', status: 'teleported' }] }, { answer: 'a', stopReason: 'x' }]) {
      globalThis.fetch = vi.fn().mockResolvedValue(res(200, bad));
      expect((await failure(new ApiClient('http://x').chat('q', 't')))?.diagnostics.errorCode).toBe('invalid_response');
    }
  });

  it('a failed turn carries only validated fields on .failure, plus Retry-After', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(resH(429, { error: 'provider_rate_limited', answer: 'fallback', stopReason: 'provider_error', steps: [{ tool: 'get_order', status: 'ok' }], leak: 'SECRET' }, { 'retry-after': '7' }));
    const err = (await failure(new ApiClient('http://x').chat('q', 't'))) as (Error & { diagnostics: ApiDiagnostics; failure?: Record<string, unknown> }) | null;
    expect(err?.diagnostics.httpStatus).toBe(429);
    expect(err?.failure).toEqual({ code: 'provider_rate_limited', answer: 'fallback', stopReason: 'provider_error', steps: [{ tool: 'get_order', status: 'ok' }], retryAfterSec: 7 });
    expect(JSON.stringify(err?.failure)).not.toContain('SECRET');
  });

  it('a failure body that is not the contract leaves no .failure, and the message is still the client\'s own wording', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(502, 'oops', false));
    const err = (await failure(new ApiClient('http://x').chat('q', 't'))) as (Error & { diagnostics: ApiDiagnostics; failure?: unknown }) | null;
    expect(err?.failure).toBeUndefined();
    expect(err?.message).toMatch(/Server error while answering/);
  });

  it.each([
    [403, 'customers_only', /Only customer accounts/], [429, 'rate_limited', /asking too fast/], [400, 'invalid_request', /Invalid question/],
    [503, 'assistant_not_configured', /not configured on this server/], [503, 'budget_exhausted', /spending guard/], [503, 'backend_unavailable', /could not fetch your data/],
    [504, 'provider_timeout', /took too long/], [504, 'turn_timeout', /took too long/], [502, 'provider_bad_output', /usable answer/],
  ])('%i %s has its own wording and never shows the code', async (status, code, message) => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(status, { error: code }, false));
    const err = await failure(new ApiClient('http://x').chat('q', 't'));
    expect(err?.message).toMatch(message);
    expect(err?.message).not.toContain(code);
  });

  it('the chat call waits longer than the default timeout (the server\'s own 504 must arrive first), but still has one', async () => {
    const f = hangingFetch();
    globalThis.fetch = f as unknown as typeof fetch;
    const chat = new ApiClient('http://x', 60).chat('q', 't'); // the default timeout here is 60 ms
    const outcome = await Promise.race([chat.then(() => 'done', () => 'rejected'), new Promise((r) => setTimeout(() => r('still waiting'), 300))]);
    expect(outcome).toBe('still waiting');
    expect((f.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(false);
    const ac = new AbortController();
    const p = new ApiClient('http://x', 60).chat('q', 't', ac.signal); ac.abort();
    expect(isCancelled(await p.then(() => null, (e: unknown) => e))).toBe(true);
    void chat.catch(() => undefined);
  });
});

describe('ApiClient EP-3 calls', () => {
  const reply3 = { answer: 'a', stopReason: 'answered', steps: [], context: { turnsSent: 1, turnsDropped: 0, historyBytes: 10 } };

  it('methods and bodies: PUT carries { value } as JSON, DELETE and GET carry no body and no Content-Type, 204 is accepted', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(200, { diet: 'vegetarian' })).mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', headers: new Headers(), json: async () => { throw new SyntaxError('empty'); } }).mockResolvedValue(res(200, []));
    globalThis.fetch = f;
    const c = new ApiClient('http://x');
    await c.setVegetarian('tok'); await c.clearDiet('tok'); await c.conversations('tok');
    const [put, del, get] = f.mock.calls.map((x) => x[1] as RequestInit);
    expect(f.mock.calls[0]![0]).toBe('http://x/assist/memories/diet');
    expect(put!.method).toBe('PUT'); expect(JSON.parse(String(put!.body))).toEqual({ value: 'vegetarian' }); expect((put!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(del!.method).toBe('DELETE'); expect(del!.body).toBeUndefined(); expect((del!.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(get!.method).toBe('GET'); expect(get!.body).toBeUndefined();
  });

  it('a conversation id is encoded into the path', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { conversationId: 'x', turns: [] }));
    globalThis.fetch = f;
    await new ApiClient('http://x').conversation('a/../b?x=1', 'tok');
    expect(f.mock.calls[0]![0]).toBe('http://x/assist/conversations/a%2F..%2Fb%3Fx%3D1');
  });

  it('responses are validated: a preference other than vegetarian, a turn without text, a reply without context', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, { diet: 'vegan' }));
    expect((await failure(new ApiClient('http://x').prefs('t')))?.diagnostics.errorCode).toBe('invalid_response');
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, { conversationId: 'c', turns: [{ turnNo: 1, answer: 'a', stopReason: 's', at: 'x' }] }));
    expect((await failure(new ApiClient('http://x').conversation('c', 't')))?.diagnostics.errorCode).toBe('invalid_response');
    globalThis.fetch = vi.fn().mockResolvedValue(res(200, { answer: 'a', stopReason: 'answered', steps: [] }));
    expect((await failure(new ApiClient('http://x').say('c', 'q', 't')))?.diagnostics.errorCode).toBe('invalid_response');
  });

  it('say() sends only { text }; a failed turn carries validated .failure with Retry-After; the chat wording covers the conversation codes', async () => {
    const f = vi.fn().mockResolvedValue(res(200, reply3));
    globalThis.fetch = f;
    await new ApiClient('http://x').say('c1', 'hello', 'tok');
    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({ text: 'hello' });
    expect(f.mock.calls[0]![0]).toBe('http://x/assist/conversations/c1/messages');
    globalThis.fetch = vi.fn().mockResolvedValue({ ...res(429, { error: 'rate_limited' }, false), headers: new Headers({ 'retry-after': '12' }) });
    const err = (await failure(new ApiClient('http://x').say('c1', 'q', 't'))) as (Error & { diagnostics: ApiDiagnostics; failure?: { code: string; retryAfterSec?: number } }) | null;
    expect(err?.failure).toMatchObject({ code: 'rate_limited', retryAfterSec: 12 });
    for (const [code, re] of [['conversation_busy', /answered first/], ['conversation_full', /50 turns/], ['invalid_history', /no longer be continued/], ['conversation_not_found', /could not be found/]] as const) {
      globalThis.fetch = vi.fn().mockResolvedValue(res(409, { error: code }, false));
      const e = await failure(new ApiClient('http://x').say('c1', 'q', 't'));
      expect(e?.message).toMatch(re); expect(e?.message).not.toContain(code);
    }
  });
});

describe('which API address a build uses', () => {
  it('uses VITE_API_URL when it is set, in development and in production', () => {
    expect(resolveApiBaseUrl({ VITE_API_URL: 'https://api.example.com', DEV: false })).toBe('https://api.example.com');
    expect(resolveApiBaseUrl({ VITE_API_URL: ' https://api.example.com ', DEV: true })).toBe('https://api.example.com');
  });
  it('development (the dev server, the tests) falls back to localhost:3000', () => {
    expect(resolveApiBaseUrl({ DEV: true })).toBe('http://localhost:3000');
    expect(resolveApiBaseUrl({ VITE_API_URL: '', DEV: true })).toBe('http://localhost:3000');
  });
  it('a production build without VITE_API_URL has NO address, not localhost', () => {
    expect(resolveApiBaseUrl({ DEV: false })).toBeNull();
    expect(resolveApiBaseUrl({ VITE_API_URL: '   ', DEV: false })).toBeNull();
  });
  it('a client with no address sends nothing and says why', async () => {
    const f = vi.fn();
    globalThis.fetch = f;
    const err = await failure(new ApiClient('').triage('hi', 'tok'));
    expect(err?.diagnostics.errorCode).toBe('api_url_not_configured');
    expect(err?.message).toMatch(/VITE_API_URL/);
    expect(f).not.toHaveBeenCalled();
  });
});
