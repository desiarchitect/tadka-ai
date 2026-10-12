import { createModelHandle, formatMeta, type ModelPort } from './llm/index.js';
import { MockLanguageModelV4 } from 'ai/test';
import { buildApp } from './app.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig } from './shared/config.js';
import { createDb } from './shared/db.js';

const config = loadConfig();
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');
const { db } = createDb(config.DATABASE_URL);

let model: ModelPort;
const llmSetup = createModelHandle();
if (llmSetup.status === 'ready') {
  for (const w of llmSetup.warnings) console.warn(`llm: ${w}`);
  console.log(`llm: ${formatMeta(llmSetup.handle.meta)}`);
  model = llmSetup.handle;
} else {
  console.warn(`llm is off: ${llmSetup.reason}; using demo mock model for assist triage.`);
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

const app = buildApp({
  db,
  keys: await loadSigningKeys(config.JWT_PRIVATE_JWK),
  provider: new HttpPaymentProvider(config.FAKE_PSP_URL),
  model,
  corsOrigins: config.CORS_ORIGIN ? [config.CORS_ORIGIN] : undefined,
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
