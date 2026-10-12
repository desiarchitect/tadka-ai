// Hard spending cap for live probe calls. A provider-side alert only notifies; this
// refuses the call BEFORE it is sent if the worst case could cross the cap.
// Prices are per provider and model (src/llm/pricing.ts). A pair with no price is refused,
// so switching provider can never silently reuse another provider's numbers.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PRICES, isPriced } from '../llm/pricing.js';

type Ledger = { budgetUsd: number; calls: { at: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }[] };

export class BudgetLedger {
  constructor(private readonly path: string, private readonly budgetUsd: number) {}

  read(): Ledger {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Ledger) : { budgetUsd: this.budgetUsd, calls: [] };
  }

  spent(): number {
    return this.read().calls.reduce((s, c) => s + c.costUsd, 0);
  }

  // `model` is a price key such as "azure:gpt-5.4-mini" (ModelHandle.priceKey).
  static cost(model: string, inputTokens: number, outputTokens: number): number {
    if (!isPriced(model)) throw new Error(`budget: no price configured for ${model}`);
    const p = PRICES[model]!;
    return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
  }

  // Worst case: every character is a token (far above reality), plus the full output cap.
  assertAffordable(model: string, promptChars: number, maxOutputTokens: number): number {
    const worst = BudgetLedger.cost(model, promptChars, maxOutputTokens);
    const spent = this.spent();
    if (spent + worst > this.budgetUsd) throw new Error(`budget: spent $${spent.toFixed(6)} + worst case $${worst.toFixed(6)} exceeds cap $${this.budgetUsd}`);
    return worst;
  }

  record(model: string, inputTokens: number, outputTokens: number): number {
    const ledger = this.read();
    const costUsd = BudgetLedger.cost(model, inputTokens, outputTokens);
    ledger.calls.push({ at: new Date().toISOString(), model, inputTokens, outputTokens, costUsd });
    writeFileSync(this.path, JSON.stringify(ledger, null, 2));
    return costUsd;
  }
}
