import { LlmConfigError, createModelHandle, formatMeta, type ModelPort } from './llm/index.js';
import { MockLanguageModelV4 } from 'ai/test';
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

let modelSetup: ReturnType<typeof createModelHandle>;
try {
  modelSetup = createModelHandle();
} catch (e) {
  if (!(e instanceof LlmConfigError)) throw e;
  console.error(`${e.message}. Fix the LLM settings in .env, or clear them to use the keyword rules.`);
  process.exit(1);
}

let model: ModelPort;
if (modelSetup.status === 'ready') {
  for (const w of modelSetup.warnings) console.warn(`warning: ${w}`);
  console.log(`llm: ${formatMeta(modelSetup.handle.meta)}`);
  model = modelSetup.handle;
} else {
  console.warn(`llm is off: ${modelSetup.reason}; using demo mock model for assist triage.`);
  model = {
    model: new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: JSON.stringify({ intent: 'order_status', language: 'hinglish', needsHuman: false, summary: 'Demo mode: customer asks about order status.' }) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 90, noCache: 90, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } },
        warnings: [],
      },
    }),
    providerOptions: {},
  };
}

const classify = modelSetup.status === 'ready'
  ? llmClassifier(modelSetup.handle, new BudgetLedger(defaultLedgerPath(), config.M0_BUDGET_USD))
  : undefined;
console.log(`POST /assist/intent classifier: ${modelSetup.status === 'ready' ? `LLM (${formatMeta(modelSetup.handle.meta)})` : `keyword rules: ${modelSetup.reason}`}`);

const app = buildApp({
  db,
  keys: await loadSigningKeys(config.JWT_PRIVATE_JWK),
  provider: new HttpPaymentProvider(config.FAKE_PSP_URL),
  classify,
  model,
  corsOrigins: config.CORS_ORIGIN ? [config.CORS_ORIGIN] : undefined,
});
await app.listen({ port: config.PORT, host: '0.0.0.0' });
