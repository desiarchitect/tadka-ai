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

// Worst case for the next request: every character counts as one token (far above reality),
// plus the system prompt and the full output cap.
export function worstCaseChars(text: string): number {
  return SYSTEM_PROMPT.length + text.length + 500;
}

// The LLM classifier behind the budget ledger. The ledger refuses BEFORE the request is sent
// if actual spend so far plus the worst case for this request could cross the cap.
export function llmClassifier(model: LanguageModel, ledger: BudgetLedger, priced: PricedModel): IntentClassifier {
  return async (text) => {
    try {
      ledger.assertAffordable(priced, worstCaseChars(text), MAX_OUTPUT_TOKENS);
    } catch {
      return { classifier: 'llm', outcome: 'provider_error', reason: 'budget' };
    }
    const r = await classifyIntent(model, text);
    if (r.usage) ledger.record(priced, r.usage.inputTokens, r.usage.outputTokens);
    return { classifier: 'llm', ...r };
  };
}

export const defaultLedgerPath = () => fileURLToPath(new URL('../../../../.m0-usage.json', import.meta.url));
