// The model boundary. Application code and scripts get their model here and nowhere else.
//
// Provider selection:
//   LLM_PROVIDER=azure|openai   explicit, the way to configure it
//   unset, only AZURE_* set     azure, with a warning (the setup this repository started with)
//   unset, both providers set   refused: the operator must choose
//   unset, nothing usable       the assistant is off
import { LlmConfigError, loadLlmConfig, type LlmConfig } from './config.js';
import { azureHandle } from './azure.js';
import { openaiHandle } from './openai.js';
import type { ModelHandle, ModelMeta } from './types.js';

export type { ModelHandle, ModelMeta, ModelPort, Provider } from './types.js';
export { LlmConfigError, loadLlmConfig } from './config.js';
export { PRICES, isPriced, priceKey } from './pricing.js';

export type LlmSetup = { status: 'ready'; handle: ModelHandle; warnings: string[] } | { status: 'off'; reason: string };

export function createModelHandle(cfg: LlmConfig = loadLlmConfig(), hooks: { fetch?: typeof fetch } = {}): LlmSetup {
  const hasAzure = Boolean(cfg.AZURE_RESOURCE_NAME && cfg.AZURE_API_KEY);
  const hasOpenai = Boolean(cfg.OPENAI_API_KEY);

  if (cfg.LLM_PROVIDER === 'azure') {
    if (!hasAzure) throw new LlmConfigError('LLM_PROVIDER=azure needs AZURE_RESOURCE_NAME and AZURE_API_KEY');
    return { status: 'ready', handle: azureHandle(cfg, hooks), warnings: [] };
  }
  if (cfg.LLM_PROVIDER === 'openai') {
    if (!hasOpenai) throw new LlmConfigError('LLM_PROVIDER=openai needs OPENAI_API_KEY');
    return { status: 'ready', handle: openaiHandle(cfg, hooks), warnings: [] };
  }
  if (hasAzure && hasOpenai) throw new LlmConfigError('Both Azure and OpenAI settings are present: set LLM_PROVIDER=azure or LLM_PROVIDER=openai');
  if (hasAzure) return { status: 'ready', handle: azureHandle(cfg, hooks), warnings: ['LLM_PROVIDER is not set; using azure because AZURE_* is set. Set LLM_PROVIDER=azure.'] };
  return { status: 'off', reason: hasOpenai ? 'OPENAI_API_KEY is set but LLM_PROVIDER is not; set LLM_PROVIDER=openai' : 'no LLM settings (set LLM_PROVIDER and its credentials)' };
}

// One line for logs and probe output. Non-secret.
export const formatMeta = (m: ModelMeta) =>
  m.provider === 'azure' ? `Foundry deployment ${m.deployment}, model ${m.modelId}` : `OpenAI model ${m.modelId}`;
