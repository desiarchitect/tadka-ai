// EP1 step 5: the frozen set, the evaluator and its budget guard. No model, no cost.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetLedger } from '../src/assist/budget.js';
import type { ClassifyResult } from '../src/assist/classifier.js';
import { EvalBudget, pairedComparison, runEval, summarize, type EvalMessage, type EvalRow } from '../src/assist/eval.js';
import { worstCaseInputTokens } from '../src/assist/classifiers.js';
import { classifyWithRules, INTENTS } from '../src/assist/intent.js';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../eval/${f}`, import.meta.url), 'utf8')) as { version: string; messages: EvalMessage[] };
const evalSet = load('intents.eval.json');
const devSet = load('intents.dev.json');
const rules = async (text: string): Promise<ClassifyResult> => ({ outcome: 'ok', intent: classifyWithRules(text), usage: { inputTokens: 0, outputTokens: 0 } });
const ok = (intent: EvalMessage['expected']): ClassifyResult => ({ outcome: 'ok', intent, usage: { inputTokens: 100, outputTokens: 5 } });

describe('the frozen evaluation set', () => {
  it('has 40 messages, valid labels, about half Hinglish and the hard cases', () => {
    expect(evalSet.messages.length).toBe(40);
    for (const m of evalSet.messages) expect(INTENTS).toContain(m.expected);
    const hinglish = evalSet.messages.filter((m) => m.lang === 'hinglish').length;
    expect(hinglish).toBeGreaterThanOrEqual(16);
    expect(hinglish).toBeLessThanOrEqual(24);
    const texts = evalSet.messages.map((m) => m.text);
    expect(texts).toContain('cancel mat karna, bas status batao');
    expect(texts).toContain('Cancel? No, just tell me where it is.');
  });

  it('shares no message with the dev set used for tuning', () => {
    const dev = new Set(devSet.messages.map((m) => m.text.toLowerCase()));
    expect(evalSet.messages.filter((m) => dev.has(m.text.toLowerCase()))).toEqual([]);
  });

  it('the rules baseline scores a stable, honest number (24 of 40) and misses the negations', async () => {
    const s = summarize(await runEval(evalSet.messages, rules));
    expect(s.correct).toBe(24);
    expect(s.accuracyPct).toBe(60);
    expect(s.hardCases.correct).toBeLessThan(s.hardCases.n);
    expect(s.confusion.find((c) => c.text === 'cancel mat karna, bas status batao')).toMatchObject({ expected: 'order_status', got: 'cancel_order' });
  });
});

describe('summarize', () => {
  it('counts failures as wrong, separately from valid "other" answers', async () => {
    const msgs: EvalMessage[] = [
      { text: 'a', expected: 'other', lang: 'en' },
      { text: 'b', expected: 'other', lang: 'en' },
      { text: 'c', expected: 'order_status', lang: 'hinglish', hard: true },
      { text: 'd', expected: 'order_status', lang: 'hinglish' },
    ];
    const answers: ClassifyResult[] = [ok('other'), { outcome: 'refusal' }, ok('cancel_order'), { outcome: 'provider_error', reason: 'x' }];
    let i = 0;
    const s = summarize(await runEval(msgs, async () => answers[i++]!));
    expect(s.total).toBe(4);
    expect(s.correct).toBe(1);
    expect(s.accuracyPct).toBe(25);
    expect(s.outcomes).toEqual({ ok: 2, refusal: 1, provider_error: 1 });
    expect(s.confusion).toEqual([{ text: 'c', expected: 'order_status', got: 'cancel_order' }]);
    expect(s.hardCases).toEqual({ n: 1, correct: 0, accuracyPct: 0 });
  });
});

describe('the budget guard stops BEFORE sending', () => {
  const msgs = evalSet.messages.slice(0, 10);

  it('a run cap smaller than one worst-case request sends nothing', async () => {
    let calls = 0;
    const budget = new EvalBudget(0.000001, 'azure:gpt-5.4-mini');
    const rows = await runEval(msgs, async () => { calls++; return ok('other'); }, budget);
    expect(calls).toBe(0);
    expect(rows.every((r) => r.outcome === 'budget_stop')).toBe(true);
    expect(summarize(rows).outcomes).toEqual({ budget_stop: 10 });
  });

  it('stops part-way when actual spend plus the next worst case would cross the cap', async () => {
    const worst = new EvalBudget(1, 'azure:gpt-5.4-mini').worstCase(msgs[0]!.text);
    // Room for the first request's worst case, then actual spend of 100 in / 5 out is tiny,
    // so make the cap just over 2 worst cases to prove the check uses spend so far.
    const budget = new EvalBudget(worst * 2.5, 'azure:gpt-5.4-mini');
    let calls = 0;
    const rows = await runEval(msgs, async () => { calls++; return { outcome: 'ok', intent: 'other', usage: { inputTokens: 1_000_000 / 4, outputTokens: 0 } }; }, budget);
    // each response "costs" 0.25M input tokens = $0.1875, far above the cap: the second request is refused
    expect(calls).toBe(1);
    expect(rows.filter((r) => r.outcome === 'budget_stop').length).toBe(9);
  });

  it('never retries after a stop, and the shared ledger cap also stops the run', async () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'ep1-')), 'usage.json'), 0.000001);
    let calls = 0;
    const rows = await runEval(msgs, async () => { calls++; return ok('other'); }, new EvalBudget(100, 'azure:gpt-5.4-mini', ledger));
    expect(calls).toBe(0);
    expect(rows.length).toBe(10);
  });

  it('records actual usage in the ledger', async () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'ep1-')), 'usage.json'), 5);
    await runEval(msgs.slice(0, 2), async () => ok('other'), new EvalBudget(1, 'azure:gpt-5.4-mini', ledger));
    expect(ledger.read().calls.length).toBe(2);
    expect(ledger.spent()).toBeGreaterThan(0);
  });
});

describe('the worst-case input bound', () => {
  it('counts UTF-8 bytes, so Devanagari is not undercounted', () => {
    const latin = 'a'.repeat(30);
    const devanagari = 'क'.repeat(30); // 30 characters, 90 bytes
    expect(worstCaseInputTokens(devanagari) - worstCaseInputTokens(latin)).toBe(60);
  });

  it('fails closed for a provider and model with no configured price, even if another provider has one', () => {
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'ep1-')), 'usage.json'), 5);
    expect(() => ledger.assertAffordable('azure:gpt-unknown', 100, 100)).toThrow(/no price configured/);
    expect(() => ledger.assertAffordable('openai:gpt-5.4-mini', 100, 100)).toThrow(/no price configured/);
  });
});

// The frozen sets are pinned by hash. Any edit, however small (a typo fix, a relabel, an added message), changes the hash
// and fails this test, so "the dataset did not change" is checked by the tests, not promised. A deliberate new dataset
// version means a new file, a new version string and a new preregistration, never an edit of these.
describe('the frozen datasets are unchanged', () => {
  const sha = (file: string) => createHash('sha256').update(readFileSync(new URL(`../eval/${file}`, import.meta.url))).digest('hex');
  it('intents.eval.json (eval-1) has the pinned SHA-256', () => {
    expect(sha('intents.eval.json')).toBe('a4c7f86df7b540586e8de33e1cb2cc705e1043290105247e9d0edba06aa53083');
  });
  it('intents.dev.json (dev-1) has the pinned SHA-256', () => {
    expect(sha('intents.dev.json')).toBe('f1c1a469204a98cf09cb3127aa0c631c937d662bb91c9194c2a1b7bcc61f7ff4');
  });
});

describe('summarize: the metrics the preregistered plan asks for', () => {
  const row = (expected: EvalRow['expected'], predicted: EvalRow['predicted'], extra: Partial<EvalRow> = {}): EvalRow => ({
    text: `${expected}-${predicted}-${Math.random()}`, expected, lang: 'en', hard: false, outcome: predicted ? 'ok' : 'provider_error', predicted, correct: predicted === expected,
    latencyMs: 10, inputTokens: 100, outputTokens: 5, costUsd: 0.0001, ...extra,
  });
  // 6 messages. true labels: 3 order_status, 2 cancel_order, 1 other.
  // answers: os->os, os->cancel, os->(timeout), cancel->cancel, cancel->os, other->(refusal)
  const rows: EvalRow[] = [
    row('order_status', 'order_status', { latencyMs: 10 }), row('order_status', 'cancel_order', { latencyMs: 20 }),
    row('order_status', undefined, { outcome: 'provider_error', reason: 'provider_timeout', latencyMs: 15000 }),
    row('cancel_order', 'cancel_order', { latencyMs: 30 }), row('cancel_order', 'order_status', { latencyMs: 40 }),
    row('other', undefined, { outcome: 'refusal', reason: 'content_filter', latencyMs: 50 }),
  ];
  const s = summarize(rows);

  it('per-intent precision and recall, by hand: a message with no valid answer is a recall miss and no precision answer', () => {
    // order_status: support 3, answered "order_status" twice (one right) -> P 50, R 33.3
    expect(s.perIntent.order_status).toEqual({ support: 3, predicted: 2, truePositives: 1, precisionPct: 50, recallPct: 33.3 });
    // cancel_order: support 2, answered twice (one right) -> P 50, R 50
    expect(s.perIntent.cancel_order).toEqual({ support: 2, predicted: 2, truePositives: 1, precisionPct: 50, recallPct: 50 });
    // other: support 1, never answered "other" -> precision undefined (null), recall 0
    expect(s.perIntent.other).toEqual({ support: 1, predicted: 0, truePositives: 0, precisionPct: null, recallPct: 0 });
    expect(s.perIntent.menu_question.support).toBe(0);
  });

  it('failure rates are shares of ALL messages, with timeouts counted inside provider errors', () => {
    expect(s.failureRates).toEqual({ refusalPct: 16.7, invalidOutputPct: 0, providerErrorPct: 16.7, timeoutPct: 16.7, budgetStopPct: 0 });
  });

  it('latency is over the requests that were sent: mean, nearest-rank p50 and p95, max', () => {
    expect(s.latency).toEqual({ sent: 6, meanMs: 2525, p50Ms: 30, p95Ms: 15000, maxMs: 15000 });
  });

  it('a budget stop is reported apart and is not part of the latency', () => {
    const stopped = summarize([...rows, { ...row('other', undefined, { outcome: 'budget_stop', latencyMs: 0 }) }]);
    expect(stopped.latency.sent).toBe(6);
    expect(stopped.failureRates.budgetStopPct).toBe(14.3);
  });
});

describe('pairedComparison', () => {
  const mk = (texts: string[], right: boolean[]): EvalRow[] => texts.map((t, i) => ({ text: t, expected: 'other', lang: 'en', hard: false, outcome: 'ok', predicted: right[i] ? 'other' : 'cancel_order', correct: right[i]!, latencyMs: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 }));
  const T = ['a', 'b', 'c', 'd', 'e'];
  it('counts both right, only the first right, only the second right, both wrong', () => {
    expect(pairedComparison(mk(T, [true, true, true, false, false]), mk(T, [true, false, false, true, false]))).toEqual({ n: 5, bothCorrect: 1, aOnly: 2, bOnly: 1, bothWrong: 1 });
  });
  it('refuses messages that differ or are in another order: such a comparison would mean nothing', () => {
    expect(() => pairedComparison(mk(T, [true, true, true, true, true]), mk(['a', 'b', 'c', 'e', 'd'], [true, true, true, true, true]))).toThrow(/same messages/);
    expect(() => pairedComparison(mk(T, [true, true, true, true, true]), mk(T.slice(1), [true, true, true, true]))).toThrow(/same messages/);
  });
});
