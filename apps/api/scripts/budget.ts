// Operator commands for the shared spending ledger (.m0-usage.json).
//
//   pnpm budget:reservations
//       Lists requests that were sent but never settled. The provider may have processed
//       them, so they stay held at their full estimate until you settle them.
//   pnpm budget:settle <id> --tokens <input>/<output>
//       Settles one at the real usage. Look it up first in Microsoft Foundry
//       (your deployment's Metrics, or Cost Management) for the time it was created.
//   pnpm budget:settle <id> --estimate
//       Settles it at the estimate already held (use when you can't find the real figure).
//
// There is deliberately no command that releases a sent request to zero.
import { BudgetLedger } from '../src/assist/budget.js';
import { defaultLedgerPath } from '../src/assist/classifiers.js';

const [cmd, id, flag, value] = process.argv.slice(2).filter((a) => a !== '--');
const ledger = new BudgetLedger(defaultLedgerPath(), Number(process.env.M0_BUDGET_USD ?? 5));

try {
  if (cmd === 'reservations') {
    const open = ledger.ambiguous();
    console.log(`spent $${ledger.spent().toFixed(6)}, committed (spent + held) $${ledger.committed().toFixed(6)}`);
    if (!open.length) console.log('no sent-but-unsettled reservations');
    for (const r of open) console.log(`${r.id}  created ${r.createdAt}  model ${r.model}  held $${r.estimateUsd.toFixed(6)}`);
  } else if (cmd === 'settle' && id && flag === '--tokens' && /^\d+\/\d+$/.test(value ?? '')) {
    const [inputTokens, outputTokens] = value!.split('/').map(Number) as [number, number];
    console.log(`settled ${id} at $${ledger.settle(id, { inputTokens, outputTokens }, 'operator').toFixed(6)}`);
  } else if (cmd === 'settle' && id && flag === '--estimate') {
    console.log(`settled ${id} at its estimate $${ledger.settle(id, 'estimate', 'operator').toFixed(6)}`);
  } else {
    console.error('usage: budget reservations | budget settle <id> --tokens <in>/<out> | budget settle <id> --estimate');
    process.exit(2);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
