import { createAzure } from '@ai-sdk/azure';
import { buildApp } from './app.js';
import { BudgetLedger } from './assist/budget.js';
import { defaultLedgerPath, llmClassifier } from './assist/classifiers.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig } from './shared/config.js';
import { createDb } from './shared/db.js';

const config = loadConfig();
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');
const { db } = createDb(config.DATABASE_URL);
const MODEL = 'gpt-5.4-mini' as const; // the model priced in the ledger
const classify = config.AZURE_API_KEY && config.AZURE_RESOURCE_NAME
  ? llmClassifier(
      createAzure({ resourceName: config.AZURE_RESOURCE_NAME, apiKey: config.AZURE_API_KEY })(config.AZURE_DEPLOYMENT || MODEL),
      new BudgetLedger(defaultLedgerPath(), config.M0_BUDGET_USD),
      MODEL,
    )
  : undefined;
console.log(`POST /assist/intent classifier: ${classify ? 'LLM (Foundry)' : 'keyword rules (no AZURE_* settings)'}`);
const app = buildApp({ db, keys: await loadSigningKeys(config.JWT_PRIVATE_JWK), provider: new HttpPaymentProvider(config.FAKE_PSP_URL), classify });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
