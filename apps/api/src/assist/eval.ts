// The evaluator: run one classifier over the frozen message set and summarise honestly.
// A failure (refusal, invalid output, provider error, budget stop) is never counted as a
// correct answer and never hidden inside "other". Accuracy always divides by the full set.
import { BudgetLedger } from './budget.js';
import { MAX_OUTPUT_TOKENS, type ClassifyResult } from './classifier.js';
import { worstCaseInputTokens } from './classifiers.js';
import { INTENTS, type Intent } from './intent.js';

export type EvalMessage = { text: string; expected: Intent; lang: 'en' | 'hinglish'; hard?: boolean };
export type EvalOutcome = ClassifyResult['outcome'] | 'budget_stop';
export type EvalRow = {
  text: string; expected: Intent; lang: EvalMessage['lang']; hard: boolean;
  outcome: EvalOutcome; predicted?: Intent; correct: boolean;
  /** Why a call produced no intent (for example provider_timeout). A category, never provider text. */
  reason?: string;
  latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number;
};

// Two limits, both checked BEFORE a request is sent: this run's own cap, and the shared
// ledger's overall cap. The check uses actual spend so far plus a conservative worst case
// for the NEXT request (the UTF-8 byte length counted as tokens, plus overhead and the full output cap). If
// the next request could cross a limit, the run stops. It never retries.
export class EvalBudget {
  private runSpent = 0;
  // `priceKey` is provider:model, for example azure:gpt-5.4-mini (ModelHandle.priceKey).
  constructor(private readonly runCapUsd: number, private readonly priceKey: string, private readonly ledger?: BudgetLedger) {}

  worstCase(text: string): number {
    return BudgetLedger.cost(this.priceKey, worstCaseInputTokens(text), MAX_OUTPUT_TOKENS);
  }

  /** Throws if sending this request could exceed the run cap or the ledger cap. */
  beforeSend(text: string): void {
    const worst = this.worstCase(text);
    if (this.runSpent + worst > this.runCapUsd) throw new Error(`run budget: spent $${this.runSpent.toFixed(6)} + worst case $${worst.toFixed(6)} exceeds $${this.runCapUsd}`);
    this.ledger?.assertAffordable(this.priceKey, worstCaseInputTokens(text), MAX_OUTPUT_TOKENS);
  }

  /** Record actual usage after a response. Returns the cost. */
  afterResponse(inputTokens: number, outputTokens: number): number {
    const cost = BudgetLedger.cost(this.priceKey, inputTokens, outputTokens);
    this.runSpent += cost;
    this.ledger?.record(this.priceKey, inputTokens, outputTokens);
    return cost;
  }

  get spent() { return this.runSpent; }
}

export async function runEval(
  messages: EvalMessage[],
  classify: (text: string) => Promise<ClassifyResult>,
  budget?: EvalBudget,
): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  let stopped = false;
  for (const m of messages) {
    const base = { text: m.text, expected: m.expected, lang: m.lang, hard: m.hard === true, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    if (stopped) { rows.push({ ...base, outcome: 'budget_stop', correct: false }); continue; }
    try { budget?.beforeSend(m.text); } catch { stopped = true; rows.push({ ...base, outcome: 'budget_stop', correct: false }); continue; }
    const started = Date.now();
    const r = await classify(m.text);
    const latencyMs = Date.now() - started;
    const inputTokens = r.usage?.inputTokens ?? 0;
    const outputTokens = r.usage?.outputTokens ?? 0;
    const costUsd = r.usage && budget ? budget.afterResponse(inputTokens, outputTokens) : 0;
    rows.push({ ...base, latencyMs, inputTokens, outputTokens, costUsd, outcome: r.outcome, predicted: r.outcome === 'ok' ? r.intent : undefined, correct: r.outcome === 'ok' && r.intent === m.expected, reason: 'reason' in r ? r.reason : undefined });
  }
  return rows;
}

const pctOf = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
const nearestRank = (sorted: number[], q: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!);

/**
 * The same messages answered by two classifiers, paired. `aOnly` and `bOnly` are the discordant pairs: the only ones
 * that say which classifier is better (McNemar's test uses exactly those two numbers). Both rows lists must be the
 * same messages in the same order, or this throws: a comparison on different messages would mean nothing.
 */
export function pairedComparison(a: EvalRow[], b: EvalRow[]) {
  if (a.length !== b.length || a.some((r, i) => r.text !== b[i]!.text || r.expected !== b[i]!.expected)) throw new Error('paired comparison needs the same messages in the same order');
  let bothCorrect = 0, aOnly = 0, bOnly = 0, bothWrong = 0;
  a.forEach((r, i) => { const o = b[i]!; if (r.correct && o.correct) bothCorrect++; else if (r.correct) aOnly++; else if (o.correct) bOnly++; else bothWrong++; });
  return { n: a.length, bothCorrect, aOnly, bOnly, bothWrong };
}

export function summarize(rows: EvalRow[]) {
  const total = rows.length;
  const pct = pctOf;
  const correct = rows.filter((r) => r.correct).length;
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const part = (f: (r: EvalRow) => boolean) => { const s = rows.filter(f); return { n: s.length, correct: s.filter((r) => r.correct).length, accuracyPct: pct(s.filter((r) => r.correct).length, s.length) }; };
  return {
    total, correct, accuracyPct: pct(correct, total), outcomes,
    english: part((r) => r.lang === 'en'), hinglish: part((r) => r.lang === 'hinglish'), hardCases: part((r) => r.hard),
    // Misses on valid answers only. Failures are listed under `outcomes`.
    confusion: rows.filter((r) => r.outcome === 'ok' && !r.correct).map((r) => ({ text: r.text, expected: r.expected, got: r.predicted! })),
    costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
    meanLatencyMs: total === 0 ? 0 : Math.round(rows.reduce((s, r) => s + r.latencyMs, 0) / total),
    // Per intent: of the messages whose true label is X (support), how many were answered X (recall); of the answers
    // "X", how many were right (precision). A message with no valid answer is a miss for recall and no answer for precision.
    perIntent: Object.fromEntries(INTENTS.map((label) => {
      const support = rows.filter((r) => r.expected === label).length;
      const predicted = rows.filter((r) => r.predicted === label).length;
      const truePositives = rows.filter((r) => r.predicted === label && r.expected === label).length;
      return [label, { support, predicted, truePositives, precisionPct: pct(truePositives, predicted), recallPct: pct(truePositives, support) }];
    })) as Record<Intent, { support: number; predicted: number; truePositives: number; precisionPct: number | null; recallPct: number | null }>,
    // Shares of ALL messages. A budget stop is reported apart: it means the run did not ask, not that the model failed.
    failureRates: {
      refusalPct: pct(outcomes.refusal ?? 0, total), invalidOutputPct: pct(outcomes.invalid_output ?? 0, total), providerErrorPct: pct(outcomes.provider_error ?? 0, total),
      timeoutPct: pct(rows.filter((r) => r.reason === 'provider_timeout').length, total), budgetStopPct: pct(outcomes.budget_stop ?? 0, total),
    },
    latency: (() => { const sent = rows.filter((r) => r.outcome !== 'budget_stop').map((r) => r.latencyMs).sort((x, y) => x - y); return { sent: sent.length, meanMs: sent.length ? Math.round(sent.reduce((x, y) => x + y, 0) / sent.length) : 0, p50Ms: nearestRank(sent, 0.5), p95Ms: nearestRank(sent, 0.95), maxMs: sent.length ? sent[sent.length - 1]! : 0 }; })(),
  };
}
