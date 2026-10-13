// The structured LLM call with a fake model: no network, no key, no cost.
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { BudgetLedger } from '../src/assist/budget.js';
import { MAX_OUTPUT_TOKENS, triage } from '../src/assist/triage.js';
import { PRICES, priceKey } from '../src/llm/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usage = { inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
const fakeReturning = (text: string) => new MockLanguageModelV4({ doGenerate: { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } });
// The options are opaque to triage: whatever the adapter chose must reach the model unchanged.
const ADAPTER_OPTIONS = { somevendor: { store: false, marker: 'chosen-by-the-adapter' } };
const port = (model: MockLanguageModelV4) => ({ model, providerOptions: ADAPTER_OPTIONS });

describe('triage (fake provider)', () => {
  it('returns a typed object and sends the cost guards', async () => {
    const model = fakeReturning(JSON.stringify({ intent: 'refund_request', language: 'en', needsHuman: true, summary: 'Wants money back for a cold biryani.' }));
    const r = await triage(port(model), 'My biryani arrived cold, I want a refund.');
    expect(r.output).toEqual({ intent: 'refund_request', language: 'en', needsHuman: true, summary: 'Wants money back for a cold biryani.' });
    const call = model.doGenerateCalls[0]!;
    expect(call.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(call.temperature).toBe(0);
    expect(call.responseFormat?.type).toBe('json');
    expect(call.providerOptions).toEqual(ADAPTER_OPTIONS);
    expect(model.doGenerateCalls.length).toBe(1);
  });

  it('rejects output that does not match the schema', async () => {
    await expect(triage(port(fakeReturning(JSON.stringify({ intent: 'pay_me', language: 'en', needsHuman: false, summary: 'x' }))), 'hi')).rejects.toThrow();
  });
});

describe('budget ledger', () => {
  it('refuses a call whose worst case would cross the cap, before it is sent', () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'm0-')), 'usage.json'), 0.0001);
    expect(() => ledger.assertAffordable('azure:gpt-5.4-mini', 2000, 400)).toThrow(/exceeds cap/);
  });

  it('records actual cost from usage', () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'm0-')), 'usage.json'), 5);
    // at the explicit upper bounds for one request (USAGE_BOUNDS): 1M input and 100k output tokens
    expect(ledger.record('azure:gpt-5.4-mini', 1_000_000, 100_000)).toBeCloseTo(1.2);
    expect(ledger.spent()).toBeCloseTo(1.2);
  });

  it('refuses a provider and model pair with no price, before anything is sent, even when another provider has one', () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'm0-')), 'usage.json'), 5);
    expect(() => ledger.assertAffordable('openai:gpt-5.4-mini', 100, 400)).toThrow(/no price configured for openai:gpt-5.4-mini/);
    expect(() => ledger.record('openai:gpt-5.4-mini', 100, 100)).toThrow(/no price configured/);
    expect(() => ledger.assertAffordable('gpt-5.4-mini', 100, 400)).toThrow(/no price configured/); // a bare model name is not a price key
    expect(ledger.spent()).toBe(0);
  });

  it('every price row says where it came from and when it was checked', () => {
    for (const [key, row] of Object.entries(PRICES)) {
      expect(key).toBe(priceKey(row.provider, row.model));
      expect(row.source.length).toBeGreaterThan(5);
      expect(row.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.tier.length).toBeGreaterThan(0);
    }
  });
});
