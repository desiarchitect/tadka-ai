import { MockLanguageModelV4 } from 'ai/test';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { issueAccessToken, loadSigningKeys } from '../src/identity/access-tokens.js';
import { HttpPaymentProvider } from '../src/payments/provider.js';
import { createDb } from '../src/shared/db.js';
import { IDS } from '../src/shared/seed-data.js';
import { TEST_DB_URL } from './global-setup.js';

describe('CORS, trace headers, and assist triage route', () => {
  let app: ReturnType<typeof buildApp>;
  let token: string;

  beforeAll(async () => {
    const { db, pool } = createDb(TEST_DB_URL);
    const keys = await loadSigningKeys();
    token = await issueAccessToken(keys, { userId: IDS.rahul, role: 'Customer' });

    const fakeModel = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: JSON.stringify({ intent: 'order_status', language: 'hinglish', needsHuman: false, summary: 'Customer asks about order status.' }) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
        warnings: [],
      },
    });

    app = buildApp({
      db,
      keys,
      provider: new HttpPaymentProvider('http://localhost:4010'),
      model: { model: fakeModel, providerOptions: {} },
      corsOrigins: ['http://localhost:5173'],
    });

    return async () => {
      await app.close();
      await pool.end();
    };
  });

  it('CORS preflight OPTIONS returns allowed origin and exposed headers', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/assist/triage',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-expose-headers']).toContain('x-trace-id');
    expect(res.headers['access-control-expose-headers']).toContain('x-request-id');
    expect(res.headers['access-control-expose-headers']).toContain('retry-after'); // so a page can read a 429's wait time
  });

  it('responses include x-request-id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('POST /assist/triage rejects request without token (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/assist/triage',
      payload: { message: 'Where is my order?' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_token');
  });

  it('POST /assist/triage rejects invalid payload (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/assist/triage',
      headers: { authorization: `Bearer ${token}` },
      payload: { message: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('POST /assist/triage returns structured output when authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/assist/triage',
      headers: { authorization: `Bearer ${token}` },
      payload: { message: 'Mera order kahan hai?' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.output.intent).toBe('order_status');
    expect(body.output.language).toBe('hinglish');
    expect(body.output.needsHuman).toBe(false);
    expect(body.authenticatedAs.userId).toBe(IDS.rahul);
    expect(body.authenticatedAs.role).toBe('Customer');
    expect(body.modelId).toBeDefined();
    expect(body.simulated).toBe(false); // a real-model app says so explicitly
  });

  it('POST /assist/triage returns 503 if model is not configured', async () => {
    const { db, pool } = createDb(TEST_DB_URL);
    const keys = await loadSigningKeys();
    const tokenForApp = await issueAccessToken(keys, { userId: IDS.rahul, role: 'Customer' });
    const appWithoutModel = buildApp({
      db,
      keys,
      provider: new HttpPaymentProvider('http://localhost:4010'),
    });
    const res = await appWithoutModel.inject({
      method: 'POST',
      url: '/assist/triage',
      headers: { authorization: `Bearer ${tokenForApp}` },
      payload: { message: 'Hello' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('provider_not_configured');
    await appWithoutModel.close();
    await pool.end();
  });
});

describe('CORS for a disallowed origin', () => {
  it('is not an error: no 500, no CORS headers, no error log. (CORS is a browser rule; auth and role still decide who may call.)', async () => {
    const { db, pool } = createDb(TEST_DB_URL);
    const lines: string[] = [];
    const app = buildApp({
      db, keys: await loadSigningKeys(), provider: new HttpPaymentProvider('http://localhost:4010'), corsOrigins: ['http://localhost:5173'],
      logger: { level: 'info', stream: { write: (l: string) => void lines.push(l) } },
    });
    const evil = { origin: 'http://evil.example' };
    const preflight = await app.inject({ method: 'OPTIONS', url: '/assist/triage', headers: { ...evil, 'access-control-request-method': 'POST' } });
    expect(preflight.statusCode).toBeLessThan(500);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const simple = await app.inject({ method: 'GET', url: '/health', headers: evil });
    expect(simple.statusCode).toBe(200); // the server still answers; the browser just will not let the page read it
    expect(simple.headers['access-control-allow-origin']).toBeUndefined();
    const unauth = await app.inject({ method: 'POST', url: '/assist/triage', headers: evil, payload: { message: 'hi' } });
    expect(unauth.statusCode).toBe(401); // authentication is enforced regardless of CORS
    const log = lines.join('');
    expect(log).not.toContain('cors_not_allowed');
    expect(log).not.toContain('"level":50');
    expect(log).not.toContain('"level":40');
    await app.close();
    await pool.end();
  });

  it('an allowed origin still gets its headers on a normal request', async () => {
    const { db, pool } = createDb(TEST_DB_URL);
    const app = buildApp({ db, keys: await loadSigningKeys(), provider: new HttpPaymentProvider('http://localhost:4010'), corsOrigins: ['http://localhost:5173'] });
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    await app.close();
    await pool.end();
  });
});
