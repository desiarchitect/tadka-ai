import { afterAll } from 'vitest';
import { buildFakePsp } from '../../fake-psp/src/app.js';
import { buildApp } from '../src/app.js';
import type { IntentClassifier } from '../src/assist/classifiers.js';
import { loadSigningKeys } from '../src/identity/access-tokens.js';
import { HttpPaymentProvider } from '../src/payments/provider.js';
import { createDb } from '../src/shared/db.js';
import { seed, SEED_PASSWORD } from '../src/shared/seed-data.js';
import { TEST_DB_URL } from './global-setup.js';

// A real API against the test database and a real fake-PSP process on a random port.
// The assist routes are limited to 10 requests a minute per user in production. Tests that are not about the limiter
// would trip it by calling a route many times as one user, so the default here is high; limiter tests set their own.
export async function startStack(opts: { classify?: IntentClassifier; rateLimitPerMin?: number; demo?: boolean } = {}) {
  const { db, pool } = createDb(TEST_DB_URL);
  await seed(db);
  const psp = buildFakePsp({ timeoutMs: 300 });
  const pspUrl = await psp.listen({ port: 0, host: '127.0.0.1' });
  const keys = await loadSigningKeys();
  const app = buildApp({ db, keys, provider: new HttpPaymentProvider(pspUrl, 150), classify: opts.classify, demo: opts.demo, triageRateLimitPerMin: opts.rateLimitPerMin ?? 1000 });
  afterAll(async () => { await app.close(); await psp.close(); await pool.end(); });

  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: SEED_PASSWORD } });
    return res.json() as { accessToken: string; refreshToken: string };
  };
  return { app, db, keys, psp, login };
}
