// The real server process, started with the documented command, and what POST /assist/triage does
// depending on DEMO_MODE and on whether a real provider is configured. No provider is ever contacted.
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
