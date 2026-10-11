// The structured LLM call with a fake model: no network, no key, no cost.
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { BudgetLedger } from '../src/assist/budget.js';
import { MAX_OUTPUT_TOKENS, triage } from '../src/assist/triage.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usage = { inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
const fakeReturning = (text: string) => new MockLanguageModelV4({ doGenerate: { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } });

describe('triage (fake provider)', () => {
  it('returns a typed object and sends the cost guards', async () => {
    const model = fakeReturning(JSON.stringify({ intent: 'refund_request', language: 'en', needsHuman: true, summary: 'Wants money back for a cold biryani.' }));
    const r = await triage(model, 'My biryani arrived cold, I want a refund.');
    expect(r.output).toEqual({ intent: 'refund_request', language: 'en', needsHuman: true, summary: 'Wants money back for a cold biryani.' });
    const call = model.doGenerateCalls[0]!;
    expect(call.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(call.temperature).toBe(0);
    expect(call.responseFormat?.type).toBe('json');
    expect(call.providerOptions?.azure).toEqual({ store: false, reasoningEffort: 'none' });
    expect(model.doGenerateCalls.length).toBe(1);
  });

  it('rejects output that does not match the schema', async () => {
    await expect(triage(fakeReturning(JSON.stringify({ intent: 'pay_me', language: 'en', needsHuman: false, summary: 'x' })), 'hi')).rejects.toThrow();
  });
});

describe('budget ledger', () => {
  it('refuses a call whose worst case would cross the cap, before it is sent', () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'm0-')), 'usage.json'), 0.0001);
    expect(() => ledger.assertAffordable('gpt-5.4-mini', 2000, 400)).toThrow(/exceeds cap/);
  });

  it('records actual cost from usage', () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'm0-')), 'usage.json'), 5);
    expect(ledger.record('gpt-5.4-mini', 1_000_000, 1_000_000)).toBeCloseTo(5.25);
    expect(ledger.spent()).toBeCloseTo(5.25);
  });
});
