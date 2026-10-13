// Who may call POST /assist/triage, how often, and how simulated answers are labelled.
import { MockLanguageModelV4 } from 'ai/test';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { demoModel } from '../src/assist/demo-model.js';
import { issueAccessToken, loadSigningKeys } from '../src/identity/access-tokens.js';
import { HttpPaymentProvider } from '../src/payments/provider.js';
import { loadConfig } from '../src/shared/config.js';
import { createDb } from '../src/shared/db.js';
import { IDS } from '../src/shared/seed-data.js';
import { TEST_DB_URL } from './global-setup.js';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const realLooking = () => new MockLanguageModelV4({ doGenerate: { content: [{ type: 'text', text: JSON.stringify({ intent: 'complaint', language: 'en', needsHuman: true, summary: 'Real-looking answer.' }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } });

describe('access and limits on /assist/triage', () => {
  let keys: Awaited<ReturnType<typeof loadSigningKeys>>;
  let db: ReturnType<typeof createDb>['db'];
  const tok = (userId: string, role: 'Customer' | 'RestaurantOwner' | 'Admin', restaurantId?: string) => issueAccessToken(keys, { userId, role, ...(restaurantId ? { restaurantId } : {}) });
  const make = (extra: Partial<Parameters<typeof buildApp>[0]> = {}) =>
    buildApp({ db, keys, provider: new HttpPaymentProvider('http://localhost:4010'), model: { model: realLooking(), providerOptions: {} }, ...extra });
  const post = (app: ReturnType<typeof buildApp>, token: string | undefined, payload: object = { message: 'where is my order' }) =>
    app.inject({ method: 'POST', url: '/assist/triage', headers: token ? { authorization: `Bearer ${token}` } : {}, payload });

  beforeAll(async () => {
    const d = createDb(TEST_DB_URL);
    db = d.db;
    keys = await loadSigningKeys();
    return async () => { await d.pool.end(); };
  });

  describe('customer only', () => {
    it('no token is 401; a restaurant owner and an admin are 403 forbidden_role; a customer is 200', async () => {
      const app = make();
      expect((await post(app, undefined)).statusCode).toBe(401);
      for (const t of [await tok(IDS.owner, 'RestaurantOwner', IDS.spiceGarden), await tok(IDS.admin, 'Admin')]) {
        const r = await post(app, t);
        expect(r.statusCode).toBe(403);
        expect(r.json()).toEqual({ error: 'forbidden_role' });
      }
      expect((await post(app, await tok(IDS.rahul, 'Customer'))).statusCode).toBe(200);
      await app.close();
    });

    it('the role comes from the verified token: a role in the body changes nothing, and a token signed by another key is 401', async () => {
      const app = make();
      const owner = await tok(IDS.owner, 'RestaurantOwner', IDS.spiceGarden);
      expect((await post(app, owner, { message: 'hi', role: 'Customer', userId: IDS.rahul })).statusCode).toBe(403);
      const other = await loadSigningKeys();
      const forged = await issueAccessToken(other, { userId: IDS.rahul, role: 'Customer' });
      const r = await post(app, forged);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'invalid_token' });
      await app.close();
    });

    it('the response names the caller from the token, not from the body', async () => {
      const app = make();
      const r = await post(app, await tok(IDS.rahul, 'Customer'), { message: 'hi', userId: IDS.aman });
      expect(r.json().authenticatedAs).toEqual({ userId: IDS.rahul, role: 'Customer' });
      await app.close();
    });
  });

  describe('per-user rate limit', () => {
    it('allows the limit, then answers 429 rate_limited with Retry-After', async () => {
      const app = make({ triageRateLimitPerMin: 3 });
      const t = await tok(IDS.rahul, 'Customer');
      for (let i = 0; i < 3; i++) expect((await post(app, t)).statusCode).toBe(200);
      const r = await post(app, t);
      expect(r.statusCode).toBe(429);
      expect(r.json()).toEqual({ error: 'rate_limited' });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      await app.close();
    });

    it('is keyed on the verified user: another user is unaffected, a second token of the same user shares the quota, a forged body field does not help', async () => {
      const app = make({ triageRateLimitPerMin: 2 });
      const rahul = await tok(IDS.rahul, 'Customer');
      const rahulAgain = await tok(IDS.rahul, 'Customer'); // new jti, same user
      const aman = await tok(IDS.aman, 'Customer');
      expect((await post(app, rahul)).statusCode).toBe(200);
      expect((await post(app, rahulAgain, { message: 'hi', userId: IDS.aman })).statusCode).toBe(200);
      expect((await post(app, rahul, { message: 'hi', userId: IDS.aman })).statusCode).toBe(429);
      expect((await post(app, rahulAgain)).statusCode).toBe(429);
      expect((await post(app, aman)).statusCode).toBe(200);
      expect((await post(app, aman)).statusCode).toBe(200);
      expect((await post(app, aman)).statusCode).toBe(429);
      await app.close();
    });

    it('requests that fail authentication or the role check never use up a customer\'s quota', async () => {
      const app = make({ triageRateLimitPerMin: 2 });
      const owner = await tok(IDS.owner, 'RestaurantOwner', IDS.spiceGarden);
      for (let i = 0; i < 5; i++) { await post(app, undefined); await post(app, owner); }
      const t = await tok(IDS.rahul, 'Customer');
      expect((await post(app, t)).statusCode).toBe(200);
      expect((await post(app, t)).statusCode).toBe(200);
      expect((await post(app, t)).statusCode).toBe(429);
      await app.close();
    });

    it('forged, garbage and non-Bearer credentials are rejected before the limiter and never charge anyone', async () => {
      const app = make({ triageRateLimitPerMin: 2 });
      const forged = await issueAccessToken(await loadSigningKeys(), { userId: IDS.rahul, role: 'Customer' }); // right user id, wrong key
      for (let i = 0; i < 6; i++) {
        expect((await post(app, forged)).statusCode).toBe(401);
        expect((await post(app, 'not.a.jwt')).statusCode).toBe(401);
        expect((await app.inject({ method: 'POST', url: '/assist/triage', headers: { authorization: 'Basic abc' }, payload: { message: 'hi' } })).statusCode).toBe(401);
      }
      const t = await tok(IDS.rahul, 'Customer');
      expect((await post(app, t)).statusCode).toBe(200);
      expect((await post(app, t)).statusCode).toBe(200);
      expect((await post(app, t)).statusCode).toBe(429);
      await app.close();
    });

    it('a signed-in customer\'s invalid message (400) does count: it passed authentication, and it is a request the customer chose to make', async () => {
      const app = make({ triageRateLimitPerMin: 2 });
      const t = await tok(IDS.rahul, 'Customer');
      expect((await post(app, t, { message: '' })).statusCode).toBe(400);
      expect((await post(app, t, { message: '' })).statusCode).toBe(400);
      expect((await post(app, t)).statusCode).toBe(429);
      await app.close();
    });

    it('applies only to triage: other routes are not limited', async () => {
      const app = make({ triageRateLimitPerMin: 1 });
      for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      await app.close();
    });
  });

  describe('simulated answers', () => {
    it('a demo app labels every answer simulated:true with modelId demo-mock', async () => {
      const app = make({ model: demoModel(), demo: true });
      const r = await post(app, await tok(IDS.rahul, 'Customer'));
      expect(r.statusCode).toBe(200);
      expect(r.json().simulated).toBe(true);
      expect(r.json().modelId).toBe('demo-mock');
      await app.close();
    });

    it('a real-model app says simulated:false explicitly, and never claims a hard-coded model name', async () => {
      const app = make();
      const r = await post(app, await tok(IDS.rahul, 'Customer'));
      expect(r.json().simulated).toBe(false);
      expect(r.json().modelId).not.toBe('demo-mock');
      expect(r.json().modelId).not.toBe('gpt-5.4-mini'); // it reports what the provider response says
      await app.close();
    });

    it('with no model and no demo flag it is 503 provider_not_configured', async () => {
      const app = make({ model: undefined });
      const r = await post(app, await tok(IDS.rahul, 'Customer'));
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ error: 'provider_not_configured' });
      await app.close();
    });
  });
});

describe('configuration', () => {
  it('DEMO_MODE: missing, empty and "0" are off; "1" is on; anything else refuses to start', () => {
    for (const v of [undefined, '', '0']) expect(loadConfig({ DEMO_MODE: v }).DEMO_MODE).toBe(false);
    expect(loadConfig({ DEMO_MODE: '1' }).DEMO_MODE).toBe(true);
    for (const v of ['true', 'yes', '2', ' 1', 'on', 'banana']) expect(() => loadConfig({ DEMO_MODE: v })).toThrow(/DEMO_MODE/);
  });

  it('a setting that is present but empty takes its default, and is never turned into 0 or an empty URL', () => {
    const c = loadConfig({ PORT: '', DATABASE_URL: '', TRIAGE_RATE_LIMIT_PER_MIN: '', TRIAGE_TIMEOUT_MS: '', M0_BUDGET_USD: '', FAKE_PSP_URL: '', DEMO_MODE: '' });
    expect(c).toMatchObject({ PORT: 3000, TRIAGE_RATE_LIMIT_PER_MIN: 10, TRIAGE_TIMEOUT_MS: 15_000, M0_BUDGET_USD: 5, DEMO_MODE: false });
    expect(c.DATABASE_URL).toMatch(/^postgres:\/\//);
    expect(c.FAKE_PSP_URL).toBe('http://localhost:4010');
  });

  it('rate limit and timeout have defaults (10 per minute, 15 s) and reject nonsense', () => {
    const c = loadConfig({});
    expect(c.TRIAGE_RATE_LIMIT_PER_MIN).toBe(10);
    expect(c.TRIAGE_TIMEOUT_MS).toBe(15_000);
    expect(loadConfig({ TRIAGE_RATE_LIMIT_PER_MIN: '3' }).TRIAGE_RATE_LIMIT_PER_MIN).toBe(3);
    for (const bad of ['0', '-1', 'abc', '1.5']) expect(() => loadConfig({ TRIAGE_RATE_LIMIT_PER_MIN: bad })).toThrow(/TRIAGE_RATE_LIMIT_PER_MIN/);
    expect(() => loadConfig({ TRIAGE_TIMEOUT_MS: '0' })).toThrow(/TRIAGE_TIMEOUT_MS/);
  });
});
