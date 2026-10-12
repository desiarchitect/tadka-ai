// What the application is allowed to know about a model. Nothing here names a vendor SDK.
import type { LanguageModel, generateText } from 'ai';

// The request options the AI SDK accepts, keyed by provider name. Taken from the SDK, not widened to any.
export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

export type Provider = 'azure' | 'openai';

// The part application code uses: the AI SDK's own model type, plus the request options the
// adapter chose for it. `providerOptions` is opaque: pass it through, never build or read it.
export type ModelPort = { model: LanguageModel; providerOptions: ProviderOptions };

// Non-secret facts about the model, for logs, evals and pricing. Never used as configuration.
export type ModelMeta = {
  provider: Provider;
  modelId: string; // the model we price and evaluate, for example gpt-5.4-mini
  deployment?: string; // Azure only: the name of YOUR deployment, which may differ from modelId
};

export type ModelHandle = ModelPort & { meta: ModelMeta; priceKey: string };
