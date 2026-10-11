import { buildApp } from './app.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig } from './shared/config.js';
import { createDb } from './shared/db.js';

const config = loadConfig();
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');
const { db } = createDb(config.DATABASE_URL);
const app = buildApp({ db, keys: await loadSigningKeys(config.JWT_PRIVATE_JWK), provider: new HttpPaymentProvider(config.FAKE_PSP_URL) });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
