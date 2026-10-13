// The real server process (the package.json command) and the intent route: the documented quick start, and demo mode
// against a provider that RECORDS every request it receives, so "zero provider calls" is observed, not assumed.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { exportPrivateJwk, issueAccessToken, loadSigningKeys } from '../src/identity/access-tokens.js';
import { IDS } from '../src/shared/seed-data.js';
import { TEST_DB_URL } from './global-setup.js';
import { startApp, stop, waitReady, type Running } from './proc.js';

const RECORDER = fileURLToPath(new URL('./fixtures/provider-recorder.mjs', import.meta.url));
const TEMPLATE = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')) as Record<string, string>;
const CREDS = { LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'my-resource', AZURE_API_KEY: 'not-a-real-key' };

describe('/assist/intent in the real process', () => {
  let jwk: string;
  let token: string;
  let running: Running | undefined;
  let file: string;
  beforeAll(async () => {
    const keys = await loadSigningKeys();
    jwk = JSON.stringify(await exportPrivateJwk(keys));
    token = await issueAccessToken(keys, { userId: IDS.rahul, role: 'Customer' });
  });
  afterEach(async () => { if (running) await stop(running); running = undefined; });

  const calls = () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  async function up(overrides: Record<string, string>) {
    file = join(mkdtempSync(join(tmpdir(), 'recorder-')), 'provider-calls.log');
    running = await startApp('api', { ...TEMPLATE, DATABASE_URL: TEST_DB_URL, JWT_PRIVATE_JWK: jwk, PROVIDER_RECORDER_FILE: file, NODE_OPTIONS: `--import ${RECORDER}`, ...overrides });
    await waitReady(running);
    return running;
  }
  const post = (r: Running, path: string, body: object) => fetch(`http://127.0.0.1:${r.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const intent = (r: Running, text = 'Please cancel my order') => post(r, '/assist/intent', { text });
  const triage = (r: Running) => post(r, '/assist/triage', { message: 'where is my order' });

  it('the recorder works: with a live provider configured, each model call is recorded (so the zero below means something)', async () => {
    const r = await up({ ...CREDS, DEMO_MODE: '0' });
    expect((await intent(r)).status).toBe(502); // the recorder answers 500, which the route turns into 502 assistant_unavailable
    expect(calls()).toBe(1);
    expect((await triage(r)).status).toBe(502);
    expect(calls()).toBe(2);
    expect(r.output()).toMatch(/POST \/assist\/intent classifier: LLM/);
  }, 30_000);

  it('DEMO_MODE=1 with provider credentials configured: triage and intent both answer, both say simulated, and the provider receives ZERO requests', async () => {
    const r = await up({ ...CREDS, DEMO_MODE: '1' });
    const t = await (await triage(r)).json() as { simulated: boolean; modelId: string };
    const i = await (await intent(r)).json() as { simulated: boolean; classifier: string; intent: string };
    expect(t).toMatchObject({ simulated: true, modelId: 'demo-mock' });
    expect(i).toMatchObject({ simulated: true, classifier: 'rules', intent: 'cancel_order' });
    expect(calls()).toBe(0);
    expect(r.output()).toMatch(/provider settings are not read/);
    expect(r.output()).toMatch(/classifier: keyword rules \(DEMO_MODE=1: no provider is used\)/);
  }, 30_000);

  it('the documented quick start (the template as copied): /assist/intent answers from the keyword rules, honestly labelled, no provider contacted', async () => {
    const r = await up({});
    const res = await intent(r, 'Mera refund kab milega?');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'ok', classifier: 'rules', simulated: false });
    expect(calls()).toBe(0);
    expect(r.output()).toMatch(/classifier: keyword rules: no LLM settings/);
  }, 30_000);

  it('a provider chosen without its key still refuses to start (live validation is not weakened), also on this branch', async () => {
    running = await startApp('api', { ...TEMPLATE, DATABASE_URL: TEST_DB_URL, JWT_PRIVATE_JWK: jwk, LLM_PROVIDER: 'azure', DEMO_MODE: '0' });
    expect((await running.exited).code).toBe(1);
    expect(running.output()).toMatch(/Startup refused: LLM_PROVIDER=azure needs AZURE_RESOURCE_NAME and AZURE_API_KEY/);
    expect(running.output()).not.toMatch(/\n\s+at .*\(/);
  }, 30_000);
});
