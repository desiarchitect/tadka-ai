// The startup decision about the model, without starting a process: which of demo / live / off, and when to refuse.
import { describe, expect, it, vi } from 'vitest';
import { selectProviderMode } from '../src/assist/provider-mode.js';
import { LlmConfigError, createModelHandle, loadLlmConfig } from '../src/llm/index.js';

const withEnv = (env: Record<string, string | undefined>) => () => createModelHandle(loadLlmConfig(env));

describe('selectProviderMode', () => {
  it('demo: the provider is never initialised, even when its settings would make initialisation throw', () => {
    const createHandle = vi.fn(withEnv({ LLM_PROVIDER: 'azure' }));
    const m = selectProviderMode({ demo: true, createHandle });
    expect(m.mode).toBe('demo');
    expect(createHandle).not.toHaveBeenCalled();
  });

  it('demo: also not initialised when the settings are complete (a demo must never be able to reach a real provider)', () => {
    const createHandle = vi.fn(withEnv({ LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'r', AZURE_API_KEY: 'k' }));
    expect(selectProviderMode({ demo: true, createHandle }).mode).toBe('demo');
    expect(createHandle).not.toHaveBeenCalled();
  });

  it('live: a complete provider choice gives a model handle', () => {
    const m = selectProviderMode({ demo: false, createHandle: withEnv({ LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'r', AZURE_API_KEY: 'k' }) });
    expect(m.mode).toBe('live');
  });

  it('off: nothing configured (an empty LLM_PROVIDER counts as unset) is a legitimate state with a reason', () => {
    const m = selectProviderMode({ demo: false, createHandle: withEnv({ LLM_PROVIDER: '', AZURE_RESOURCE_NAME: '', AZURE_API_KEY: '' }) });
    expect(m).toMatchObject({ mode: 'off' });
    expect((m as { reason: string }).reason).toMatch(/no LLM settings/);
  });

  it('a provider that is chosen but incomplete is refused, not treated as off: live validation is not weakened', () => {
    for (const env of [{ LLM_PROVIDER: 'azure' }, { LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'r' }, { LLM_PROVIDER: 'openai' }, { LLM_PROVIDER: 'nope' }]) {
      expect(() => selectProviderMode({ demo: false, createHandle: withEnv(env) })).toThrow(LlmConfigError);
    }
  });
});
