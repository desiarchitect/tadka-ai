// EP1 step 2: the intent schema and the rules baseline. No model involved.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyWithRules, IntentOutput, INTENTS } from '../src/assist/intent.js';

describe('IntentOutput schema', () => {
  it('accepts exactly the five intents', () => {
    for (const intent of INTENTS) expect(IntentOutput.safeParse({ intent }).success).toBe(true);
    expect(IntentOutput.safeParse({ intent: 'pay_me' }).success).toBe(false);
  });

  it('rejects unexpected fields and missing fields', () => {
    expect(IntentOutput.safeParse({ intent: 'other', summary: 'x' }).success).toBe(false);
    expect(IntentOutput.safeParse({ intent: 'other', userId: 'u1' }).success).toBe(false);
    expect(IntentOutput.safeParse({}).success).toBe(false);
  });
});

describe('rules baseline', () => {
  it('handles the plain cases', () => {
    expect(classifyWithRules('Where is my order?')).toBe('order_status');
    expect(classifyWithRules('Please cancel my order')).toBe('cancel_order');
    expect(classifyWithRules('I want a refund')).toBe('refund_request');
    expect(classifyWithRules('What is on the menu?')).toBe('menu_question');
    expect(classifyWithRules('Thanks, bye')).toBe('other');
  });

  it('documented limit: negation is invisible to keywords', () => {
    // The customer does NOT want to cancel. The keyword "cancel" still wins.
    expect(classifyWithRules('cancel mat karna, bas batao kab aayega')).toBe('cancel_order');
  });

  it('is deterministic', () => {
    expect(classifyWithRules('mera order kab aayega')).toBe(classifyWithRules('mera order kab aayega'));
  });

  it('the dev set is the only set used for tuning', () => {
    const dev = JSON.parse(readFileSync(new URL('../eval/intents.dev.json', import.meta.url), 'utf8')) as { messages: { text: string; expected: string }[] };
    expect(dev.messages.length).toBeGreaterThanOrEqual(8);
    for (const m of dev.messages) expect(INTENTS).toContain(m.expected);
  });
});
