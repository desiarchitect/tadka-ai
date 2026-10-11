// Hard spending cap for live probe calls. A provider-side alert only notifies; this
// refuses the call BEFORE it is sent if the worst case could cross the cap.
// Prices: Microsoft Foundry, Global Standard deployment, USD per 1M tokens, from the Azure
// Retail Prices API as shown on azurespeed.com (checked 2026-10-11). Data Zone deployments cost
// about 10-20% more. Update them if the price changes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const PRICES = {
  'gpt-5.4-mini': { inputPerM: 0.75, outputPerM: 4.5 },
  'gpt-5.4-nano': { inputPerM: 0.2, outputPerM: 1.25 },
} as const;
export type PricedModel = keyof typeof PRICES;

type Ledger = { budgetUsd: number; calls: { at: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }[] };

export class BudgetLedger {
  constructor(private readonly path: string, private readonly budgetUsd: number) {}

  read(): Ledger {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Ledger) : { budgetUsd: this.budgetUsd, calls: [] };
  }

  spent(): number {
    return this.read().calls.reduce((s, c) => s + c.costUsd, 0);
  }

  static cost(model: PricedModel, inputTokens: number, outputTokens: number): number {
    const p = PRICES[model];
    return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
  }

  // Worst case: every character is a token (far above reality), plus the full output cap.
  assertAffordable(model: PricedModel, promptChars: number, maxOutputTokens: number): number {
    const worst = BudgetLedger.cost(model, promptChars, maxOutputTokens);
    const spent = this.spent();
    if (spent + worst > this.budgetUsd) throw new Error(`budget: spent $${spent.toFixed(6)} + worst case $${worst.toFixed(6)} exceeds cap $${this.budgetUsd}`);
    return worst;
  }

  record(model: PricedModel, inputTokens: number, outputTokens: number): number {
    const ledger = this.read();
    const costUsd = BudgetLedger.cost(model, inputTokens, outputTokens);
    ledger.calls.push({ at: new Date().toISOString(), model, inputTokens, outputTokens, costUsd });
    writeFileSync(this.path, JSON.stringify(ledger, null, 2));
    return costUsd;
  }
}
