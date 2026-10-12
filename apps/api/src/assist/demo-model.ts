// The simulated model used only when DEMO_MODE=1. It answers every message the same way, so
// anything it produces must be labelled as simulated (see `simulated` in the triage response).
import { MockLanguageModelV4 } from 'ai/test';
import type { ModelPort } from '../llm/types.js';

export const DEMO_MODEL_ID = 'demo-mock';

export function demoModel(): ModelPort {
  return {
    model: new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: JSON.stringify({ intent: 'order_status', language: 'hinglish', needsHuman: false, summary: 'Simulated answer: demo mode does not read the message.' }) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 90, noCache: 90, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } },
        warnings: [],
      },
    }),
    providerOptions: {},
  };
}
