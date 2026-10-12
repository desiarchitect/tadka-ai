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
