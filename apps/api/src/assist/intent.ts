// The intent contract for EP1. The model returns ONE field. Everything else (what to
// say, what to do) is decided by application code from that field.
import { z } from 'zod';

export const INTENTS = ['order_status', 'cancel_order', 'refund_request', 'menu_question', 'other'] as const;
export type Intent = (typeof INTENTS)[number];

// Strict: an unexpected field is invalid output, not something to ignore silently.
export const IntentOutput = z.strictObject({ intent: z.enum(INTENTS) });
export type IntentOutput = z.infer<typeof IntentOutput>;

// The rules baseline: keywords, checked in a fixed order. It is deliberately the kind of
// thing a team writes first. It is fast, free and fully testable, and it cannot read
// negation ("cancel mat karna") or a question inside a sentence. The evaluation shows
// where it breaks. Tuned only on eval/intents.dev.json, never on the evaluation set.
const RULES: { intent: Intent; pattern: RegExp }[] = [
  { intent: 'refund_request', pattern: /refund|money back|paise wapas|paisa wapas|wapas chahiye|reimburse/i },
  { intent: 'cancel_order', pattern: /cancel/i },
  { intent: 'order_status', pattern: /status|kahan|kahaan|where|kab aay|kab tak|when will|late|track|abhi tak/i },
  { intent: 'menu_question', pattern: /menu|veg\b|vegetarian|price|kitn[ae]|spicy|ingredients|available|milta|milti/i },
];

export function classifyWithRules(text: string): Intent {
  for (const r of RULES) if (r.pattern.test(text)) return r.intent;
  return 'other';
}
