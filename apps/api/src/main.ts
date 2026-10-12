import { buildApp } from './app.js';
import { BudgetLedger } from './assist/budget.js';
import { defaultLedgerPath, llmClassifier } from './assist/classifiers.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { LlmConfigError, createModelHandle, formatMeta } from './llm/index.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig } from './shared/config.js';
import { createDb } from './shared/db.js';

const config = loadConfig();
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');
const { db } = createDb(config.DATABASE_URL);
let model: ReturnType<typeof createModelHandle>;
try { model = createModelHandle(); } catch (e) {
  if (!(e instanceof LlmConfigError)) throw e;
  console.error(`${e.message}. Fix the LLM settings in .env, or clear them to use the keyword rules.`);
  process.exit(1);
}
if (model.status === 'ready') for (const w of model.warnings) console.warn(`warning: ${w}`);
const classify = model.status === 'ready' ? llmClassifier(model.handle, new BudgetLedger(defaultLedgerPath(), config.M0_BUDGET_USD)) : undefined;
console.log(`POST /assist/intent classifier: ${model.status === 'ready' ? `LLM (${formatMeta(model.handle.meta)})` : `keyword rules: ${model.reason}`}`);
const app = buildApp({ db, keys: await loadSigningKeys(config.JWT_PRIVATE_JWK), provider: new HttpPaymentProvider(config.FAKE_PSP_URL), classify });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
