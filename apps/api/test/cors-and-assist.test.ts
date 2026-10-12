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
