// How the assist routes get their model. One decision, made once at startup, with three outcomes:
//
//   demo  DEMO_MODE=1. The simulated model. Provider settings are NOT READ at all, so a half-filled
//         .env cannot stop a demo from starting and a demo can never reach a real provider.
//   live  A provider is configured (LLM_PROVIDER, or only AZURE_* set) and complete: a real model.
//   off   Nothing is configured. Triage answers 503 provider_not_configured.
//
// A provider that is chosen but incomplete (LLM_PROVIDER=azure without a key, or an unknown value)
// is not "off": it throws LlmConfigError, and main refuses to start with a one-line message.
// Silently running without the model you asked for would hide the mistake.
import { createModelHandle, type ModelHandle, type ModelPort } from '../llm/index.js';
import { demoModel } from './demo-model.js';

export type ProviderMode =
  | { mode: 'demo'; model: ModelPort }
  | { mode: 'live'; handle: ModelHandle; warnings: string[] }
  | { mode: 'off'; reason: string };

export function selectProviderMode(opts: { demo: boolean; createHandle?: typeof createModelHandle }): ProviderMode {
  if (opts.demo) return { mode: 'demo', model: demoModel() };
  const setup = (opts.createHandle ?? createModelHandle)();
  return setup.status === 'ready' ? { mode: 'live', handle: setup.handle, warnings: setup.warnings } : { mode: 'off', reason: setup.reason };
}
