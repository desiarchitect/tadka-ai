import { LlmConfigError, formatMeta, type ModelPort } from './llm/index.js';
import { buildApp } from './app.js';
import { BudgetLedger } from './assist/budget.js';
import { DEFAULT_LOOP } from './assist/agent-loop.js';
import { defaultLedgerPath, llmClassifier } from './assist/classifiers.js';
import { selectProviderMode } from './assist/provider-mode.js';
import { fileAudit } from './assist/tools/audit.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig, type Config } from './shared/config.js';
import { createDb } from './shared/db.js';
import { createShutdown, installSignalHandlers, telemetryStage } from './shutdown.js';

// A configuration mistake is a message and exit code 1, never a stack trace.
const refuse = (message: string): never => { console.error(`Startup refused: ${message}`); process.exit(1); };

let config: Config;
try { config = loadConfig(); } catch (e) { config = refuse((e as Error).message); }
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');

// One decision for the model-spending routes (see src/assist/provider-mode.ts): demo never reads provider settings.
let mode: ReturnType<typeof selectProviderMode>;
try {
  mode = selectProviderMode({ demo: config.DEMO_MODE });
} catch (e) {
  if (!(e instanceof LlmConfigError)) throw e;
  mode = refuse(`${e.message}. Fill in the missing value in .env, or leave LLM_PROVIDER empty (the keyword rules then answer /assist/intent; set DEMO_MODE=1 for simulated triage answers).`);
}

let model: ModelPort | undefined;
if (mode.mode === 'demo') {
  console.warn('DEMO_MODE=1: /assist/triage returns SIMULATED answers (modelId demo-mock). No real model is called and provider settings are not read. /assist/chat is off.');
  model = mode.model;
} else if (mode.mode === 'live') {
  for (const w of mode.warnings) console.warn(`llm: ${w}`);
  console.log(`llm: ${formatMeta(mode.handle.meta)}`);
  model = mode.handle;
} else {
  console.warn(`llm is off: ${mode.reason}. /assist/triage answers 503 provider_not_configured (set DEMO_MODE=1 for simulated answers) and /assist/chat answers 503 assistant_not_configured.`);
}

// One spending ledger for every live call. The LLM classifier and the tool-calling assistant exist only in live mode.
const ledger = new BudgetLedger(defaultLedgerPath(), config.M0_BUDGET_USD);
const classify = mode.mode === 'live' ? llmClassifier(mode.handle, ledger) : undefined;
console.log(`POST /assist/intent classifier: ${mode.mode === 'live' ? `LLM (${formatMeta(mode.handle.meta)})` : mode.mode === 'demo' ? 'keyword rules (DEMO_MODE=1: no provider is used)' : `keyword rules: ${mode.reason}`}`);

// Requests that were reserved but never sent are released; sent-but-unsettled ones stay held.
const { released, ambiguous } = ledger.reconcile();
if (released) console.log(`budget: released ${released} reservation(s) that were never sent`);
if (ambiguous.length) console.warn(`budget: ${ambiguous.length} sent request(s) were never settled and stay held. Run pnpm budget:reservations.`);
const assistant = mode.mode === 'live' ? {
  model: mode.handle.model,
  providerOptions: mode.handle.providerOptions,
  ledger,
  audit: fileAudit('logs/security-audit.jsonl', config.AUDIT_HMAC_KEY || undefined),
  config: {
    ...DEFAULT_LOOP,
    priceKey: mode.handle.priceKey,
    maxOutputTokens: config.ASSIST_MAX_OUTPUT_TOKENS,
    turnBudgetUsd: config.ASSIST_TURN_BUDGET_USD,
    estimateMargin: config.ASSIST_ESTIMATE_MARGIN,
  },
} : undefined;
console.log(`POST /assist/chat: ${mode.mode === 'live' ? `${formatMeta(mode.handle.meta)}, priced as ${mode.handle.priceKey}` : `off (${mode.mode === 'demo' ? 'DEMO_MODE=1' : mode.reason})`}`);

const { db, pool } = createDb(config.DATABASE_URL);

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
