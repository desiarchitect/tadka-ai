// The two ways the app can classify a message. Both return the same shape, so the route
// does not care which one it has.
import type { LanguageModel } from 'ai';
import { fileURLToPath } from 'node:url';
import { BudgetLedger, type PricedModel } from './budget.js';
import { classifyIntent, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT, type ClassifyResult } from './classifier.js';
import { classifyWithRules } from './intent.js';

export type IntentClassifier = (text: string) => Promise<ClassifyResult & { classifier: 'llm' | 'rules' }>;

// No model, no key, no cost. The default when no Azure settings are present.
export const rulesClassifier: IntentClassifier = async (text) => ({
  classifier: 'rules',
  outcome: 'ok',
  intent: classifyWithRules(text),
  usage: { inputTokens: 0, outputTokens: 0 },
});

// Conservative estimate of the input tokens of the next request, not a guaranteed bound.
// Subword tokenizers usually produce fewer tokens than UTF-8 bytes, including for Devanagari
// (three bytes per character, so counting characters would undercount it). The fixed overhead
// covers the response-format schema and the provider's request framing. The provider's
// account spending limit remains the hard safeguard.
export const REQUEST_OVERHEAD_TOKENS = 500;
export function worstCaseInputTokens(text: string): number {
  return Buffer.byteLength(SYSTEM_PROMPT, 'utf8') + Buffer.byteLength(text, 'utf8') + REQUEST_OVERHEAD_TOKENS;
}

// The LLM classifier behind the budget ledger. The ledger refuses BEFORE the request is sent
// if actual spend so far plus the worst case for this request could cross the cap.
export function llmClassifier(model: LanguageModel, ledger: BudgetLedger, priced: PricedModel): IntentClassifier {
  return async (text) => {
    try {
      ledger.assertAffordable(priced, worstCaseInputTokens(text), MAX_OUTPUT_TOKENS);
    } catch {
      return { classifier: 'llm', outcome: 'provider_error', reason: 'budget' };
    }
    const r = await classifyIntent(model, text);
    if (r.usage) ledger.record(priced, r.usage.inputTokens, r.usage.outputTokens);
    return { classifier: 'llm', ...r };
  };
}

export const defaultLedgerPath = () => fileURLToPath(new URL('../../../../.m0-usage.json', import.meta.url));
