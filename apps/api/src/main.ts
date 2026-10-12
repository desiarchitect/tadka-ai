import { createAzure } from '@ai-sdk/azure';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { buildApp } from './app.js';
import { loadSigningKeys } from './identity/access-tokens.js';
import { HttpPaymentProvider } from './payments/provider.js';
import { loadConfig } from './shared/config.js';
import { createDb } from './shared/db.js';

const config = loadConfig();
if (!config.JWT_PRIVATE_JWK) console.warn('JWT_PRIVATE_JWK unset: using a fresh dev signing key; tokens end when the process restarts.');
const { db } = createDb(config.DATABASE_URL);

let model: LanguageModel;
if (config.AZURE_RESOURCE_NAME && config.AZURE_API_KEY) {
  const azure = createAzure({ resourceName: config.AZURE_RESOURCE_NAME, apiKey: config.AZURE_API_KEY });
  model = azure(config.AZURE_DEPLOYMENT);
  console.log(`LLM provider active: Microsoft Foundry deployment "${config.AZURE_DEPLOYMENT}"`);
} else {
  console.warn('AZURE_API_KEY / AZURE_RESOURCE_NAME unset: assist triage running with demo mock model.');
  model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify({ intent: 'order_status', language: 'hinglish', needsHuman: false, summary: 'Demo mode: customer asks about order status.' }) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 90, noCache: 90, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } },
      warnings: [],
    },
  });
}

const app = buildApp({
  db,
  keys: await loadSigningKeys(config.JWT_PRIVATE_JWK),
  provider: new HttpPaymentProvider(config.FAKE_PSP_URL),
  model,
  corsOrigins: config.CORS_ORIGIN ? [config.CORS_ORIGIN] : undefined,
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
