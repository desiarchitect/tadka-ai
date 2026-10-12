// The direct OpenAI API adapter. The only file that may import @ai-sdk/openai.
import { createOpenAI } from '@ai-sdk/openai';
import type { LlmConfig } from './config.js';
import { priceKey } from './pricing.js';
import type { ModelHandle } from './types.js';

export function openaiHandle(cfg: LlmConfig, hooks: { fetch?: typeof fetch } = {}): ModelHandle {
  const openai = createOpenAI({ apiKey: cfg.OPENAI_API_KEY!, fetch: hooks.fetch });
  return {
    model: openai.responses(cfg.LLM_MODEL),
    // The same two protections as the Azure adapter, under this provider's own key.
    providerOptions: { openai: { store: false, reasoningEffort: 'none' } },
    meta: { provider: 'openai', modelId: cfg.LLM_MODEL },
    priceKey: priceKey('openai', cfg.LLM_MODEL),
  };
}
