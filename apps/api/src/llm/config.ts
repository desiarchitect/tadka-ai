// Which model provider to use, read from the environment in one place.
import { z } from 'zod';

// An empty value (`AZURE_API_KEY=` in .env) counts as not set.
const opt = z.string().optional().transform((v) => v?.trim() || undefined);

const env = z.object({
  LLM_PROVIDER: opt.pipe(z.enum(['azure', 'openai']).optional()),
  LLM_MODEL: opt.transform((v) => v ?? 'gpt-5.4-mini'), // the model we price and evaluate
  AZURE_RESOURCE_NAME: opt,
  AZURE_API_KEY: opt,
  AZURE_DEPLOYMENT: opt, // your Azure deployment name; defaults to LLM_MODEL
  OPENAI_API_KEY: opt,
});

export type LlmConfig = z.infer<typeof env>;
export class LlmConfigError extends Error {}

export const loadLlmConfig = (source: Record<string, string | undefined> = process.env): LlmConfig => {
  const r = env.safeParse(source);
  if (!r.success) throw new LlmConfigError(`LLM_PROVIDER must be "azure" or "openai" (got ${JSON.stringify(source.LLM_PROVIDER)})`);
  return r.data;
};
