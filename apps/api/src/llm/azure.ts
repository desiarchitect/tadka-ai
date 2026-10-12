// The Azure (Microsoft Foundry) adapter. The only file that may import @ai-sdk/azure.
import { createAzure } from '@ai-sdk/azure';
import { LlmConfigError, type LlmConfig } from './config.js';
import { priceKey } from './pricing.js';
import type { ModelHandle } from './types.js';

// The AI SDK decides what a model supports (reasoning, temperature) from the NAME it is given, and
// on Azure that name is your deployment's. A name like "my-deployment" is not recognised, so
// reasoningEffort and temperature would be dropped with only a warning, and reasoning tokens
// would be billed. Refuse such a name up front. This mirrors the SDK's own pattern; the
// adapter contract test fails if the SDK stops accepting a name this accepts.
const RECOGNISED_DEPLOYMENT = /^(gpt-\d+(\.\d+)?(-.+)?|o\d+(-.+)?)$/;

export function azureHandle(cfg: LlmConfig, hooks: { fetch?: typeof fetch } = {}): ModelHandle {
  const azure = createAzure({ resourceName: cfg.AZURE_RESOURCE_NAME!, apiKey: cfg.AZURE_API_KEY!, fetch: hooks.fetch });
  const deployment = cfg.AZURE_DEPLOYMENT ?? cfg.LLM_MODEL;
  if (!RECOGNISED_DEPLOYMENT.test(deployment)) {
    throw new LlmConfigError(`AZURE_DEPLOYMENT "${deployment}" is not named like a GPT model (for example gpt-5.4-mini or gpt-5.4-mini-1), so the AI SDK would not apply the reasoning settings. Rename the deployment or choose one named after the model.`);
  }
  return {
    model: azure.responses(deployment),
    // store: false: the Responses API keeps responses by default.
    // reasoningEffort 'none': a classification needs no reasoning tokens, which cost output-token prices.
    // Options are keyed by the provider name the SDK uses, so they live here with the adapter.
    providerOptions: { azure: { store: false, reasoningEffort: 'none' } },
    meta: { provider: 'azure', modelId: cfg.LLM_MODEL, deployment },
    priceKey: priceKey('azure', cfg.LLM_MODEL),
  };
}
