import { LlmConfigError, createModelHandle, formatMeta, type ModelPort } from './llm/index.js';
import { demoModel } from './assist/demo-model.js';
import { buildApp } from './app.js';
import { BudgetLedger } from './assist/budget.js';
import { DEFAULT_LOOP } from './assist/agent-loop.js';
import { defaultLedgerPath, llmClassifier } from './assist/classifiers.js';
import { fileAudit } from './assist/tools/audit.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig } from './shared/config.js';
import { createDb } from './shared/db.js';
import { createShutdown, installSignalHandlers, telemetryStage } from './shutdown.js';

const config = loadConfig();
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');
const { db, pool } = createDb(config.DATABASE_URL);
const ledger = new BudgetLedger(defaultLedgerPath(), config.M0_BUDGET_USD);
let setup: ReturnType<typeof createModelHandle>;
try {
  setup = createModelHandle();
} catch (e) {
  if (!(e instanceof LlmConfigError)) throw e;
  console.error(`${e.message}. Fix the LLM settings in .env, or clear them to run without a model.`);
  process.exit(1);
}

if (setup.status === 'ready') for (const w of setup.warnings) console.warn(`warning: ${w}`);
const handle = setup.status === 'ready' ? setup.handle : undefined;
const classify = handle && llmClassifier(handle, ledger);
console.log(`POST /assist/intent classifier: ${handle ? `LLM (${formatMeta(handle.meta)})` : `keyword rules: ${setup.status === 'off' ? setup.reason : ''}`}`);

let model: ModelPort | undefined;
if (config.DEMO_MODE) {
  // Explicit opt-in. Every triage response is marked simulated; a real provider setting is ignored.
  console.warn('DEMO_MODE=1: /assist/triage returns SIMULATED answers (modelId demo-mock). No real model is called.');
  model = demoModel();
} else if (handle) {
  model = handle;
} else {
  console.warn(`llm is off: ${setup.status === 'off' ? setup.reason : ''}. /assist/triage answers 503 provider_not_configured (set DEMO_MODE=1 for simulated answers).`);
}

// Requests that were reserved but never sent are released; sent-but-unsettled ones stay held.
const { released, ambiguous } = ledger.reconcile();
if (released) console.log(`budget: released ${released} reservation(s) that were never sent`);
if (ambiguous.length) console.warn(`budget: ${ambiguous.length} sent request(s) were never settled and stay held. Run pnpm budget:reservations.`);
const assistant = handle && {
  model: handle.model,
  providerOptions: handle.providerOptions,
  ledger,
  audit: fileAudit('logs/security-audit.jsonl', config.AUDIT_HMAC_KEY || undefined),
  config: {
    ...DEFAULT_LOOP,
    priceKey: handle.priceKey,
    maxOutputTokens: config.ASSIST_MAX_OUTPUT_TOKENS,
    turnBudgetUsd: config.ASSIST_TURN_BUDGET_USD,
    estimateMargin: config.ASSIST_ESTIMATE_MARGIN,
  },
};
console.log(`POST /assist/chat: ${handle ? `${formatMeta(handle.meta)}, priced as ${handle.priceKey}` : `off (${setup.status === 'off' ? setup.reason : ''})`}`);

const app = buildApp({
  db,
  keys: await loadSigningKeys(config.JWT_PRIVATE_JWK),
  provider: new HttpPaymentProvider(config.FAKE_PSP_URL),
  classify,
  assistant,
  model,
  demo: config.DEMO_MODE,
  triageRateLimitPerMin: config.TRIAGE_RATE_LIMIT_PER_MIN,
  triageTimeoutMs: config.TRIAGE_TIMEOUT_MS,
  corsOrigins: config.CORS_ORIGIN ? [config.CORS_ORIGIN] : undefined,
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });

const shutdownMs = process.env.SHUTDOWN_DEADLINE_MS ? Number(process.env.SHUTDOWN_DEADLINE_MS) : undefined;
installSignalHandlers(createShutdown({
  deadlineMs: shutdownMs,
  stages: [{ name: 'server', run: () => app.close() }, { name: 'database', run: () => pool.end() }, telemetryStage()],
}));
