// Runs one ledger action in its own process, for the cross-process and crash tests.
import { BudgetLedger } from '../../src/assist/budget.js';

const [path, action, arg] = process.argv.slice(2) as [string, string, string];
const ledger = new BudgetLedger(path, 1);
if (action === 'reserve') {
  console.log(JSON.stringify({ id: ledger.reserve('azure:gpt-5.4-mini', Number(arg), 't') }));
} else if (action === 'send-then-crash') {
  const id = ledger.reserve('azure:gpt-5.4-mini', Number(arg), 't')!;
  ledger.markSent(id);
  console.log(JSON.stringify({ id }));
  process.kill(process.pid, 'SIGKILL'); // dies before the response, so before settlement
} else if (action === 'settle') {
  try { ledger.settle(arg, 'estimate', 'operator'); console.log(JSON.stringify({ ok: true })); } catch { console.log(JSON.stringify({ ok: false })); }
}
