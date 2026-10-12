// Which provider is chosen, and when the answer is "none" or "refuse".
import { describe, expect, it } from 'vitest';
import { LlmConfigError, createModelHandle, formatMeta, loadLlmConfig } from '../src/llm/index.js';

const AZURE = { AZURE_RESOURCE_NAME: 'my-resource', AZURE_API_KEY: 'azure-secret-key' };
const OPENAI = { OPENAI_API_KEY: 'openai-secret-key' };
const setup = (env: Record<string, string>) => createModelHandle(loadLlmConfig(env));

describe('provider selection', () => {
  it('LLM_PROVIDER picks the provider, and the other provider settings are ignored', () => {
    const a = setup({ LLM_PROVIDER: 'azure', ...AZURE, ...OPENAI });
    const o = setup({ LLM_PROVIDER: 'openai', ...AZURE, ...OPENAI });
    expect(a.status === 'ready' && a.handle.meta.provider).toBe('azure');
    expect(o.status === 'ready' && o.handle.meta.provider).toBe('openai');
  });

  it('an explicit provider without its credentials is an error that names the variables, never their values', () => {
    expect(() => setup({ LLM_PROVIDER: 'azure', OPENAI_API_KEY: 'openai-secret-key' })).toThrow(/AZURE_RESOURCE_NAME and AZURE_API_KEY/);
    expect(() => setup({ LLM_PROVIDER: 'openai', ...AZURE })).toThrow(/OPENAI_API_KEY/);
    for (const env of [{ LLM_PROVIDER: 'openai', ...AZURE }, { LLM_PROVIDER: 'azure', ...OPENAI }]) {
      try { setup(env); } catch (e) { expect(String(e)).not.toMatch(/secret/); }
    }
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'gemini' })).toThrow(LlmConfigError);
  });

  it('unset with only Azure settings keeps working, with a warning to set LLM_PROVIDER', () => {
    const r = setup(AZURE);
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.handle.meta.provider).toBe('azure');
      expect(r.warnings.join(' ')).toMatch(/LLM_PROVIDER=azure/);
    }
  });

  it('unset with both providers configured is refused: the machine does not choose silently', () => {
    expect(() => setup({ ...AZURE, ...OPENAI })).toThrow(/set LLM_PROVIDER/);
  });

  it('unset with nothing usable is off, and an OpenAI key alone is not enough to select OpenAI', () => {
    expect(setup({})).toMatchObject({ status: 'off' });
    expect(setup({ AZURE_RESOURCE_NAME: '', AZURE_API_KEY: '', LLM_PROVIDER: '' })).toMatchObject({ status: 'off' });
    expect(setup(OPENAI)).toMatchObject({ status: 'off', reason: expect.stringContaining('LLM_PROVIDER=openai') });
  });
});

describe('model identity and deployment identity', () => {
  it('the model we price is LLM_MODEL; the Azure deployment name is separate and defaults to it', () => {
    const named = setup({ LLM_PROVIDER: 'azure', ...AZURE, AZURE_DEPLOYMENT: 'gpt-5.4-mini-1' });
    const dflt = setup({ LLM_PROVIDER: 'azure', ...AZURE });
    expect(named.status === 'ready' && named.handle.meta).toEqual({ provider: 'azure', modelId: 'gpt-5.4-mini', deployment: 'gpt-5.4-mini-1' });
    expect(named.status === 'ready' && named.handle.priceKey).toBe('azure:gpt-5.4-mini');
    expect(dflt.status === 'ready' && dflt.handle.meta.deployment).toBe('gpt-5.4-mini');
  });

  it('the price key follows the provider, so the same model is a different price row', () => {
    const a = setup({ LLM_PROVIDER: 'azure', ...AZURE });
    const o = setup({ LLM_PROVIDER: 'openai', ...OPENAI });
    expect(a.status === 'ready' && a.handle.priceKey).toBe('azure:gpt-5.4-mini');
    expect(o.status === 'ready' && o.handle.priceKey).toBe('openai:gpt-5.4-mini');
  });

  it('metadata is structured and non-secret; the log line is formatted from it', () => {
    const a = setup({ LLM_PROVIDER: 'azure', ...AZURE, AZURE_DEPLOYMENT: 'gpt-5.4-mini-2' });
    const o = setup({ LLM_PROVIDER: 'openai', ...OPENAI, LLM_MODEL: 'gpt-5.4-nano' });
    if (a.status !== 'ready' || o.status !== 'ready') throw new Error('expected ready');
    expect(formatMeta(a.handle.meta)).toBe('Foundry deployment gpt-5.4-mini-2, model gpt-5.4-mini');
    expect(formatMeta(o.handle.meta)).toBe('OpenAI model gpt-5.4-nano');
    expect(JSON.stringify([a.handle.meta, o.handle.meta])).not.toMatch(/secret/);
  });
});
