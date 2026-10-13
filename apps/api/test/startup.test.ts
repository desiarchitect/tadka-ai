// The real server process, started with the documented command, and what POST /assist/triage does
// depending on DEMO_MODE and on whether a real provider is configured. No provider is ever contacted.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { exportPrivateJwk, issueAccessToken, loadSigningKeys } from '../src/identity/access-tokens.js';
import { IDS } from '../src/shared/seed-data.js';
import { startApp, stop, waitReady, type Running } from './proc.js';
import { TEST_DB_URL } from './global-setup.js';

describe('startup: demo mode versus a missing provider', () => {
  let jwk: string;
  let token: string;
  let running: Running | undefined;
  beforeAll(async () => {
    const keys = await loadSigningKeys();
    jwk = JSON.stringify(await exportPrivateJwk(keys));
    token = await issueAccessToken(keys, { userId: IDS.rahul, role: 'Customer' });
  });
  afterEach(async () => { if (running) await stop(running); running = undefined; });

  const triage = (r: Running) => fetch(`http://127.0.0.1:${r.port}/assist/triage`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'What is the capital of France?' }),
  });
  const start = async (env: Record<string, string>) => {
    running = await startApp('api', { DATABASE_URL: TEST_DB_URL, JWT_PRIVATE_JWK: jwk, ...env });
    await waitReady(running);
    return running;
  };

  it.each([['unset', {}], ['empty', { DEMO_MODE: '' }], ['0', { DEMO_MODE: '0' }]])('DEMO_MODE %s with no provider: 503 provider_not_configured, never a canned answer', async (_n, env) => {
    const r = await start(env);
    const res = await triage(r);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'provider_not_configured' });
    expect(r.output()).toMatch(/503 provider_not_configured/);
  }, 30_000);

  it('DEMO_MODE=1: 200 with simulated:true and modelId demo-mock, and the server says so at startup', async () => {
    const r = await start({ DEMO_MODE: '1' });
    const res = await triage(r);
    expect(res.status).toBe(200);
    const body = await res.json() as { simulated: boolean; modelId: string; output: { summary: string } };
    expect(body.simulated).toBe(true);
    expect(body.modelId).toBe('demo-mock');
    expect(body.output.summary).toMatch(/^Simulated/);
    expect(r.output()).toMatch(/DEMO_MODE=1/);
  }, 30_000);

  it.each(['banana', 'true', 'yes', '2'])('DEMO_MODE=%s refuses to start', async (value) => {
    const r = await startApp('api', { DATABASE_URL: TEST_DB_URL, JWT_PRIVATE_JWK: jwk, DEMO_MODE: value });
    const { code } = await r.exited;
    expect(code).not.toBe(0);
    expect(r.output()).toMatch(/DEMO_MODE must be "1" or "0"/);
    await stop(r);
  }, 30_000);
});

// The documented quick start is `cp .env.example .env` and then start. These tests do exactly that: the real
// template, parsed the way `--env-file` parses it, and the real process started with the package.json command.
describe('startup from the copied .env.example (the documented quick start)', () => {
  const TEMPLATE = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')) as Record<string, string>;
  let jwk: string;
  let token: string;
  let running: Running | undefined;
  beforeAll(async () => {
    const keys = await loadSigningKeys();
    jwk = JSON.stringify(await exportPrivateJwk(keys));
    token = await issueAccessToken(keys, { userId: IDS.rahul, role: 'Customer' });
  });
  afterEach(async () => { if (running) await stop(running); running = undefined; });

  // Only what a developer machine must differ on is overridden: the test database and a fixed signing key.
  const launch = (overrides: Record<string, string> = {}) => startApp('api', { ...TEMPLATE, DATABASE_URL: TEST_DB_URL, JWT_PRIVATE_JWK: jwk, ...overrides });
  const up = async (overrides: Record<string, string> = {}) => { running = await launch(overrides); await waitReady(running); return running; };
  const triage = (r: Running) => fetch(`http://127.0.0.1:${r.port}/assist/triage`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'where is my order' }) });
  const noStack = (out: string) => { expect(out).not.toMatch(/\n\s+at .*\(/); expect(out).not.toMatch(/LlmConfigError:|ZodError|Error: /); };

  it('the template says LLM_PROVIDER is empty, so a fresh checkout has no half-made provider choice', () => {
    expect(TEMPLATE.LLM_PROVIDER).toBe('');
    expect(TEMPLATE.DEMO_MODE).toBe('0');
  });

  it('as copied (DEMO_MODE=0, no credentials): the API starts, says the model is off, and triage is an honest 503', async () => {
    const r = await up();
    const res = await triage(r);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'provider_not_configured' });
    expect(r.output()).toMatch(/llm is off/);
    noStack(r.output());
  }, 30_000);

  it('as copied with DEMO_MODE=1: the API starts and answers are labelled simulated', async () => {
    const r = await up({ DEMO_MODE: '1' });
    const body = await (await triage(r)).json() as { simulated: boolean; modelId: string };
    expect(body).toMatchObject({ simulated: true, modelId: 'demo-mock' });
    noStack(r.output());
  }, 30_000);

  it('demo mode does not read provider settings: a half-filled provider choice cannot stop it from starting', async () => {
    const r = await up({ DEMO_MODE: '1', LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: '', AZURE_API_KEY: '' });
    expect((await triage(r)).status).toBe(200);
    expect(r.output()).toMatch(/provider settings are not read/);
    noStack(r.output());
  }, 30_000);

  it('live mode with the provider chosen but the key missing: refuses to start, in one clear line, naming the setting (never a value)', async () => {
    running = await launch({ LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'my-resource', AZURE_API_KEY: '' });
    const { code } = await running.exited;
    const out = running.output();
    expect(code).toBe(1);
    expect(out).toMatch(/Startup refused: LLM_PROVIDER=azure needs AZURE_RESOURCE_NAME and AZURE_API_KEY/);
    expect(out).not.toContain('my-resource');
    noStack(out);
  }, 30_000);

  it.each([['an unknown provider', { LLM_PROVIDER: 'gemini' }, /LLM_PROVIDER must be "azure" or "openai"/], ['openai chosen without its key', { LLM_PROVIDER: 'openai' }, /LLM_PROVIDER=openai needs OPENAI_API_KEY/], ['a deployment the SDK would not treat as a GPT model', { LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'r', AZURE_API_KEY: 'k', AZURE_DEPLOYMENT: 'my-deployment' }, /not named like a GPT model/]])('live mode, %s: refuses to start with a clear message', async (_n, overrides, message) => {
    running = await launch(overrides);
    const { code } = await running.exited;
    expect(code).toBe(1);
    expect(running.output()).toMatch(message);
    noStack(running.output());
  }, 30_000);

  it('live mode with a complete provider choice starts and names the model (no request is made at startup)', async () => {
    const r = await up({ LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'my-resource', AZURE_API_KEY: 'not-a-real-key', DEMO_MODE: '0' });
    expect(r.output()).toMatch(/llm: Foundry deployment gpt-5.4-mini/);
    expect(r.output()).not.toContain('not-a-real-key');
  }, 30_000);

  it('blank numeric settings (TRIAGE_RATE_LIMIT_PER_MIN=, PORT-like empties) mean "use the default", not a crash and not zero', async () => {
    await up({ TRIAGE_RATE_LIMIT_PER_MIN: '', TRIAGE_TIMEOUT_MS: '', M0_BUDGET_USD: '', CORS_ORIGIN: '' });
    expect(running!.output()).not.toMatch(/Startup refused/);
  }, 30_000);

  it('a wrong numeric value is refused with the setting named', async () => {
    running = await launch({ TRIAGE_TIMEOUT_MS: 'soon' });
    expect((await running.exited).code).toBe(1);
    expect(running.output()).toMatch(/Startup refused: invalid setting: TRIAGE_TIMEOUT_MS/);
    noStack(running.output());
  }, 30_000);
});
