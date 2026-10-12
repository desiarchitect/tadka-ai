import { LlmConfigError, formatMeta, type ModelPort } from './llm/index.js';
import { buildApp } from './app.js';
import { selectProviderMode } from './assist/provider-mode.js';
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

let mode: ReturnType<typeof selectProviderMode>;
try {
  mode = selectProviderMode({ demo: config.DEMO_MODE });
} catch (e) {
  if (!(e instanceof LlmConfigError)) throw e;
  mode = refuse(`${e.message}. Fill in the missing value in .env, or leave LLM_PROVIDER empty (set DEMO_MODE=1 for simulated answers).`);
}

let model: ModelPort | undefined;
if (mode.mode === 'demo') {
  console.warn('DEMO_MODE=1: /assist/triage returns SIMULATED answers (modelId demo-mock). No real model is called and provider settings are not read.');
  model = mode.model;
} else if (mode.mode === 'live') {
  for (const w of mode.warnings) console.warn(`llm: ${w}`);
  console.log(`llm: ${formatMeta(mode.handle.meta)}`);
  model = mode.handle;
} else {
  console.warn(`llm is off: ${mode.reason}. /assist/triage answers 503 provider_not_configured (set DEMO_MODE=1 for simulated answers).`);
}

const { db, pool } = createDb(config.DATABASE_URL);

const app = buildApp({
  db,
  keys: await loadSigningKeys(config.JWT_PRIVATE_JWK),
  provider: new HttpPaymentProvider(config.FAKE_PSP_URL),
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
