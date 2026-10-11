import { createAzure } from '@ai-sdk/azure';
import { buildApp } from './app.js';
import { BudgetLedger } from './assist/budget.js';
import { DEFAULT_LOOP } from './assist/agent-loop.js';
import { defaultLedgerPath, llmClassifier } from './assist/classifiers.js';
import { fileAudit } from './assist/tools/audit.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig } from './shared/config.js';
import { createDb } from './shared/db.js';

const config = loadConfig();
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');
const { db } = createDb(config.DATABASE_URL);
const MODEL = 'gpt-5.4-mini' as const; // the model priced in the ledger
const ledger = new BudgetLedger(defaultLedgerPath(), config.M0_BUDGET_USD);
const model = config.AZURE_API_KEY && config.AZURE_RESOURCE_NAME
  ? createAzure({ resourceName: config.AZURE_RESOURCE_NAME, apiKey: config.AZURE_API_KEY })(config.AZURE_DEPLOYMENT || MODEL)
  : undefined;
const classify = model && llmClassifier(model, ledger, MODEL);
console.log(`POST /assist/intent classifier: ${classify ? 'LLM (Foundry)' : 'keyword rules (no AZURE_* settings)'}`);

// Requests that were reserved but never sent are released; sent-but-unsettled ones stay held.
const { released, ambiguous } = ledger.reconcile();
if (released) console.log(`budget: released ${released} reservation(s) that were never sent`);
if (ambiguous.length) console.warn(`budget: ${ambiguous.length} sent request(s) were never settled and stay held. Run pnpm budget:reservations.`);
const assistant = model && {
  model, ledger, audit: fileAudit('logs/security-audit.jsonl', config.AUDIT_HMAC_KEY || undefined),
  config: { ...DEFAULT_LOOP, pricedModel: config.ASSIST_PRICED_AS, maxOutputTokens: config.ASSIST_MAX_OUTPUT_TOKENS, turnBudgetUsd: config.ASSIST_TURN_BUDGET_USD, estimateMargin: config.ASSIST_ESTIMATE_MARGIN },
};
console.log(`POST /assist/chat: ${assistant ? `Foundry deployment ${config.AZURE_DEPLOYMENT || MODEL}, priced as ${config.ASSIST_PRICED_AS}` : 'off (no AZURE_* settings)'}`);
const app = buildApp({ db, keys: await loadSigningKeys(config.JWT_PRIVATE_JWK), provider: new HttpPaymentProvider(config.FAKE_PSP_URL), classify, assistant });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
