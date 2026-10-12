import { createModelHandle, formatMeta, type ModelPort } from './llm/index.js';
import { demoModel } from './assist/demo-model.js';
import { buildApp } from './app.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig } from './shared/config.js';
import { createDb } from './shared/db.js';
import { createShutdown, installSignalHandlers, telemetryStage } from './shutdown.js';

const config = loadConfig();
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');
const { db, pool } = createDb(config.DATABASE_URL);

let model: ModelPort | undefined;
if (config.DEMO_MODE) {
  // Explicit opt-in. Every triage response is marked simulated; a real provider setting is ignored.
  console.warn('DEMO_MODE=1: /assist/triage returns SIMULATED answers (modelId demo-mock). No real model is called.');
  model = demoModel();
} else {
  const llmSetup = createModelHandle();
  if (llmSetup.status === 'ready') {
    for (const w of llmSetup.warnings) console.warn(`llm: ${w}`);
    console.log(`llm: ${formatMeta(llmSetup.handle.meta)}`);
    model = llmSetup.handle;
  } else {
    console.warn(`llm is off: ${llmSetup.reason}. /assist/triage answers 503 provider_not_configured (set DEMO_MODE=1 for simulated answers).`);
  }
}

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
