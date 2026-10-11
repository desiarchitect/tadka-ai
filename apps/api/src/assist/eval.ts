// The evaluator: run one classifier over the frozen message set and summarise honestly.
// A failure (refusal, invalid output, provider error, budget stop) is never counted as a
// correct answer and never hidden inside "other". Accuracy always divides by the full set.
import { BudgetLedger, type PricedModel } from './budget.js';
import { MAX_OUTPUT_TOKENS, type ClassifyResult } from './classifier.js';
import { worstCaseInputTokens } from './classifiers.js';
import type { Intent } from './intent.js';

export type EvalMessage = { text: string; expected: Intent; lang: 'en' | 'hinglish'; hard?: boolean };
export type EvalOutcome = ClassifyResult['outcome'] | 'budget_stop';
export type EvalRow = {
  text: string; expected: Intent; lang: EvalMessage['lang']; hard: boolean;
  outcome: EvalOutcome; predicted?: Intent; correct: boolean;
  latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number;
};

// Two limits, both checked BEFORE a request is sent: this run's own cap, and the shared
// ledger's overall cap. The check uses actual spend so far plus a conservative worst case
// for the NEXT request (the UTF-8 byte length counted as tokens, plus overhead and the full output cap). If
// the next request could cross a limit, the run stops. It never retries.
export class EvalBudget {
  private runSpent = 0;
  constructor(private readonly runCapUsd: number, private readonly priced: PricedModel, private readonly ledger?: BudgetLedger) {}

  worstCase(text: string): number {
    return BudgetLedger.cost(this.priced, worstCaseInputTokens(text), MAX_OUTPUT_TOKENS);
  }

  /** Throws if sending this request could exceed the run cap or the ledger cap. */
  beforeSend(text: string): void {
    const worst = this.worstCase(text);
    if (this.runSpent + worst > this.runCapUsd) throw new Error(`run budget: spent $${this.runSpent.toFixed(6)} + worst case $${worst.toFixed(6)} exceeds $${this.runCapUsd}`);
    this.ledger?.assertAffordable(this.priced, worstCaseInputTokens(text), MAX_OUTPUT_TOKENS);
  }

  /** Record actual usage after a response. Returns the cost. */
  afterResponse(inputTokens: number, outputTokens: number): number {
    const cost = BudgetLedger.cost(this.priced, inputTokens, outputTokens);
    this.runSpent += cost;
    this.ledger?.record(this.priced, inputTokens, outputTokens);
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
    rows.push({ ...base, latencyMs, inputTokens, outputTokens, costUsd, outcome: r.outcome, predicted: r.outcome === 'ok' ? r.intent : undefined, correct: r.outcome === 'ok' && r.intent === m.expected });
  }
  return rows;
}

export function summarize(rows: EvalRow[]) {
  const total = rows.length;
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
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
  };
}
