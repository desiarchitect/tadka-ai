// Operator commands for the shared spending ledger (.m0-usage.json). See RUNBOOK, "Ledger recovery".
//
//   pnpm budget:status
//       Spent, committed, whether live calls are BLOCKED (and why), whether the file is CORRUPT.
//   pnpm budget:reservations
//       Lists requests that were sent but never settled. The provider may have processed
//       them, so they stay held at their full estimate until you settle them.
//   pnpm budget:settle <id> --tokens <input>/<output>
//       Settles one at the real usage. Look it up first with your provider
//       (Foundry deployment Metrics or Cost Management, or the OpenAI usage page) for the time it was created.
//   pnpm budget:settle <id> --estimate
//       Settles it at the estimate already held (use when you can't find the real figure).
//   pnpm budget:clear-halt -- --reason "<why it is safe>" --confirm
//       Lifts a block the ledger put on itself (a usage figure that was malformed or implausible). Needs a reason and
//       --confirm. A copy of the file as it is now is kept next to it, and the reason, the block and your user name are
//       written into the ledger's events. The spending record is not changed.
//   pnpm budget:start-over -- --baseline-spent-usd <n> --reason "<why>" --confirm
//       Only for a ledger file that cannot be read (CORRUPT). Moves the file aside (kept, never deleted) and starts a new
//       one whose opening balance is <n> dollars: the spend you established from the provider's own billing. There is no
//       default and 0 must be typed.
//
// There is deliberately no command that releases a sent request to zero, none that resets the ledger without a baseline,
// and nothing here runs by itself: the application never clears a block or replaces a ledger.
// M0_LEDGER_PATH overrides the file (the tests use it); leave it unset to act on the file the API uses.
import { BudgetLedger, LedgerCorruptError } from '../src/assist/budget.js';
import { defaultLedgerPath } from '../src/assist/classifiers.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const [cmd, ...rest] = args;
const path = process.env.M0_LEDGER_PATH ?? defaultLedgerPath();
const budget = Number(process.env.M0_BUDGET_USD ?? 5);
const ledger = new BudgetLedger(path, budget);
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const has = (name: string) => rest.includes(name);
const usage = (msg?: string): never => {
  if (msg) console.error(msg);
  console.error('usage: budget status | reservations | settle <id> --tokens <in>/<out> | settle <id> --estimate\n       budget clear-halt --reason "<why>" --confirm\n       budget start-over --baseline-spent-usd <n> --reason "<why>" --confirm');
  return process.exit(2);
};

try {
  if (cmd === 'status') {
    try {
      const l = ledger.read();
      console.log(`ledger ${path}\nspent $${ledger.spent().toFixed(6)}, committed (spent + held) $${ledger.committed(l).toFixed(6)}, cap $${budget}`);
      if (l.halted) console.log(`BLOCKED since ${l.halted.at}: ${l.halted.reason}${l.halted.reservationId ? ` (reservation ${l.halted.reservationId})` : ''}\n  Live calls are refused until an operator runs: budget clear-halt --reason "..." --confirm`);
      else console.log('not blocked');
      console.log(`${ledger.ambiguous().length} sent-but-unsettled reservation(s)`);
    } catch (e) {
      if (!(e instanceof LedgerCorruptError)) throw e;
      console.log(`CORRUPT: ${e.message}\n  The file was not changed. See RUNBOOK, "Ledger recovery", then: budget start-over --baseline-spent-usd <n> --reason "..." --confirm`);
    }
  } else if (cmd === 'reservations') {
    const open = ledger.ambiguous();
    console.log(`spent $${ledger.spent().toFixed(6)}, committed (spent + held) $${ledger.committed().toFixed(6)}`);
    if (!open.length) console.log('no sent-but-unsettled reservations');
    for (const r of open) console.log(`${r.id}  created ${r.createdAt}  model ${r.model}  held $${r.estimateUsd.toFixed(6)}`);
  } else if (cmd === 'settle' && rest[0] && rest[1] === '--tokens' && /^\d+\/\d+$/.test(rest[2] ?? '')) {
    const [inputTokens, outputTokens] = rest[2]!.split('/').map(Number) as [number, number];
    console.log(`settled ${rest[0]} at $${ledger.settle(rest[0], { inputTokens, outputTokens }, 'operator').toFixed(6)}`);
  } else if (cmd === 'settle' && rest[0] && rest[1] === '--estimate') {
    console.log(`settled ${rest[0]} at its estimate $${ledger.settle(rest[0], 'estimate', 'operator').toFixed(6)}`);
  } else if (cmd === 'clear-halt') {
    const reason = flag('--reason');
    if (!reason) usage('clear-halt needs --reason "<why it is safe to continue>"');
    if (!has('--confirm')) usage('clear-halt changes what the application may spend. Read `budget status`, then add --confirm.');
    const { evidencePath } = ledger.clearHalt(reason!);
    console.log(`block cleared. The ledger as it was is kept in ${evidencePath}`);
  } else if (cmd === 'start-over') {
    const reason = flag('--reason');
    const baseline = flag('--baseline-spent-usd');
    if (baseline === undefined) usage('start-over needs --baseline-spent-usd <n>: the dollars already spent according to your provider\'s billing (type 0 only if that is what it shows)');
    if (!reason) usage('start-over needs --reason "<why>"');
    if (!has('--confirm')) usage('start-over replaces the accounting baseline. Add --confirm once you have the figure from the provider.');
    const { evidencePath } = BudgetLedger.quarantineCorrupt(path, budget, Number(baseline), reason!);
    console.log(`the corrupt file was moved to ${evidencePath} (kept). A new ledger starts at $${Number(baseline).toFixed(6)} spent.`);
  } else {
    usage();
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
