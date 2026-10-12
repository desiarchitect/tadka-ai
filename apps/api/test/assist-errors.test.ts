// Provider failures on POST /assist/triage: the client gets an application-owned status and code,
// and neither the response nor the log carries provider text, urls, keys or the customer's message.
// The provider is a fake model that throws. This proves our mapping, not how Foundry behaves.
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { issueAccessToken, loadSigningKeys } from '../src/identity/access-tokens.js';
import { HttpPaymentProvider } from '../src/payments/provider.js';
import { createDb } from '../src/shared/db.js';
import { IDS } from '../src/shared/seed-data.js';
import { TEST_DB_URL } from './global-setup.js';

const SECRET = 'sk-SECRET-123';
const RESOURCE = 'my-secret-resource';
const CUSTOMER_TEXT = 'my private order note 98765';
const leakyText = `Access denied for key ${SECRET} on ${RESOURCE}`;
const apiError = (statusCode: number | undefined, responseHeaders?: Record<string, string>) =>
  new APICallError({ message: leakyText, url: `https://${RESOURCE}.openai.azure.com/openai/v1/responses`, requestBodyValues: { input: CUSTOMER_TEXT }, statusCode, responseHeaders, responseBody: leakyText, isRetryable: false });

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const throwing = (err: unknown) => new MockLanguageModelV4({ doGenerate: async () => { throw err; } });

describe('provider failures on /assist/triage', () => {
  let keys: Awaited<ReturnType<typeof loadSigningKeys>>;
  let token: string;
  let db: ReturnType<typeof createDb>['db'];
  beforeAll(async () => {
    const d = createDb(TEST_DB_URL);
    db = d.db;
    keys = await loadSigningKeys();
    token = await issueAccessToken(keys, { userId: IDS.rahul, role: 'Customer' });
    return async () => { await d.pool.end(); };
  });

  const call = async (model: MockLanguageModelV4, opts: { triageTimeoutMs?: number } = {}) => {
    const lines: string[] = [];
    const app = buildApp({
      db, keys, provider: new HttpPaymentProvider('http://localhost:4010'), model: { model, providerOptions: {} },
      logger: { level: 'warn', stream: { write: (l: string) => void lines.push(l) } }, ...opts,
    });
    const res = await app.inject({ method: 'POST', url: '/assist/triage', headers: { authorization: `Bearer ${token}` }, payload: { message: CUSTOMER_TEXT } });
    await app.close();
    return { res, log: lines.join('') };
  };

  const CASES: [string, unknown, number, string][] = [
    ['provider 401', apiError(401), 502, 'provider_auth'],
    ['provider 403', apiError(403), 502, 'provider_auth'],
    ['provider 429', apiError(429, { 'retry-after': '7' }), 429, 'provider_rate_limited'],
    ['provider 500', apiError(500), 502, 'provider_unavailable'],
    ['provider 404 (bad deployment)', apiError(404), 502, 'provider_unavailable'],
    ['network failure (no status)', apiError(undefined), 502, 'provider_unavailable'],
    ['provider 504', apiError(504), 504, 'provider_timeout'],
  ];

  it.each(CASES)('%s becomes %i %s, without provider text in the response or the log', async (_name, err, status, code) => {
    const { res, log } = await call(throwing(err));
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: code });
    for (const leak of [SECRET, RESOURCE, 'Access denied', CUSTOMER_TEXT, 'openai.azure.com', token]) {
      expect(res.body).not.toContain(leak);
      expect(log).not.toContain(leak);
    }
    expect(log).toContain(code); // it is still diagnosable from the log: class, provider status, our code
  });

  it('keeps what is safe to troubleshoot with: error class, provider status, its error code and type, its request id', async () => {
    const err = new APICallError({
      message: leakyText, url: `https://${RESOURCE}.openai.azure.com/x`, requestBodyValues: { input: CUSTOMER_TEXT }, statusCode: 404, isRetryable: false,
      responseHeaders: { 'x-request-id': 'req_abc-123', 'set-cookie': `session=${SECRET}` }, responseBody: leakyText,
      data: { error: { message: leakyText, type: 'invalid_request_error', code: 'DeploymentNotFound', param: 'model' } },
    });
    const { res, log } = await call(throwing(err));
    expect(res.statusCode).toBe(502);
    expect(log).toContain('"providerStatus":404');
    expect(log).toContain('DeploymentNotFound');
    expect(log).toContain('invalid_request_error');
    expect(log).toContain('req_abc-123');
    expect(log).toContain('APICallError');
    for (const leak of [SECRET, RESOURCE, 'Access denied', CUSTOMER_TEXT, 'set-cookie', 'session=']) expect(log).not.toContain(leak);
  });

  it('a provider "code" that is free text rather than an identifier is not logged', async () => {
    const err = new APICallError({
      message: 'm', url: 'https://x', requestBodyValues: {}, statusCode: 400, isRetryable: false,
      responseHeaders: { 'x-request-id': `the key is ${SECRET}` },
      data: { error: { code: `bad request, key ${SECRET}`, type: 'a'.repeat(200) } },
    });
    const { log } = await call(throwing(err));
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('aaaaaaaa');
    expect(log).toContain('"providerStatus":400');
  });

  it('a provider answer that cannot be read at all (malformed or empty) is provider_bad_output, not an internal error', async () => {
    const { InvalidResponseDataError, EmptyResponseBodyError } = await import('ai');
    for (const err of [new InvalidResponseDataError({ data: { secret: SECRET }, message: leakyText }), new EmptyResponseBodyError({ message: leakyText })]) {
      const { res, log } = await call(throwing(err));
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'provider_bad_output' });
      expect(res.body + log).not.toContain(SECRET);
    }
  });

  it('a provider authentication failure cannot be mistaken for the application rejecting the caller', async () => {
    const { res } = await call(throwing(apiError(401)));
    expect(res.statusCode).not.toBe(401);
    expect(['missing_token', 'invalid_token', 'forbidden_role']).not.toContain(res.json().error);
  });

  it('passes a provider Retry-After through as a number only', async () => {
    const { res } = await call(throwing(apiError(429, { 'retry-after': '7' })));
    expect(res.headers['retry-after']).toBe('7');
    const { res: res2 } = await call(throwing(apiError(429, { 'retry-after': 'soon, see https://x.example' })));
    expect(res2.headers['retry-after']).toBeUndefined();
  });

  it('unusable model output becomes 502 provider_bad_output', async () => {
    const bad = new MockLanguageModelV4({ doGenerate: { content: [{ type: 'text', text: JSON.stringify({ intent: 'pay_me' }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } });
    const { res, log } = await call(bad);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'provider_bad_output' });
    expect(log).not.toContain('pay_me'); // the model's raw output is not logged either
  });

  it('an error that is not a provider failure is still a plain 500 with no details', async () => {
    const { res } = await call(throwing(new Error('database exploded')));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
  });

  it('a provider call that never answers is cut off at the timeout: 504 provider_timeout, and the model sees the abort', async () => {
    let seen: AbortSignal | undefined;
    const hang = new MockLanguageModelV4({
      doGenerate: (opts) => new Promise((_resolve, reject) => {
        seen = opts.abortSignal;
        opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal?.reason));
      }),
    });
    const started = Date.now();
    const { res } = await call(hang, { triageTimeoutMs: 150 });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: 'provider_timeout' });
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
