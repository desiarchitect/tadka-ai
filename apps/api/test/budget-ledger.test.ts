// EP2 section 3b: reservations in the shared ledger. Separate processes, like separate turns.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { BudgetLedger } from '../src/assist/budget.js';

const run = promisify(execFile);
const child = fileURLToPath(new URL('./fixtures/ledger-child.ts', import.meta.url));
const inChild = async (path: string, action: string, arg: string) => {
  try {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', child, path, action, arg]);
    return JSON.parse(stdout.trim().split('\n').pop()!);
  } catch (e) {
    // the crash case is killed on purpose; its stdout is still useful
    return JSON.parse((e as { stdout: string }).stdout.trim().split('\n').pop()!);
  }
};
const fresh = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'usage.json');

describe('reservations', () => {
  it('concurrent processes cannot spend the same allowance: only the affordable ones reserve', async () => {
    const path = fresh(); // cap $1, each wants $0.3: three fit, five try
    const results = await Promise.all(Array.from({ length: 5 }, () => inChild(path, 'reserve', '0.3')));
    expect(results.filter((r) => r.id).length).toBe(3);
    expect(new BudgetLedger(path, 1).committed()).toBeCloseTo(0.9);
  }, 30_000);

  it('a crash after sending leaves the reservation held, and restart does not release it', async () => {
    const path = fresh();
    const { id } = await inChild(path, 'send-then-crash', '0.4');
    const ledger = new BudgetLedger(path, 1);
    const reserved = ledger.reserve('gpt-5.4-mini', 0.1, 'other'); // never sent
    const { released, ambiguous } = ledger.reconcile();
    expect(released).toBe(1);
    expect(ambiguous.map((r) => r.id)).toEqual([id]);
    expect(ledger.read().reservations!.find((r) => r.id === reserved)!.state).toBe('released');
    expect(ledger.committed()).toBeCloseTo(0.4); // still held at its full estimate
    expect(ledger.ambiguous().map((r) => r.id)).toEqual([id]);
  }, 30_000);

  it('manual settlement applies once: a repeat, an unknown id and a concurrent double settle are refused', async () => {
    const path = fresh();
    const ledger = new BudgetLedger(path, 1);
    const a = ledger.reserve('gpt-5.4-mini', 0.2, 't')!;
    ledger.markSent(a);
    expect(ledger.settle(a, { inputTokens: 1000, outputTokens: 100 }, 'operator')).toBeCloseTo(0.0012);
    expect(() => ledger.settle(a, 'estimate', 'operator')).toThrow(/settled, not sent/);
    expect(() => ledger.settle('nope', 'estimate', 'operator')).toThrow(/unknown/);
    const b = ledger.reserve('gpt-5.4-mini', 0.2, 't')!;
    ledger.markSent(b);
    const both = await Promise.all([inChild(path, 'settle', b), inChild(path, 'settle', b)]);
    expect(both.filter((r) => r.ok).length).toBe(1);
    expect(ledger.read().calls.filter((c) => c.reservationId === b).length).toBe(1);
  }, 30_000);

  it('a released reservation cannot be settled, and an unpriced model cannot reserve', () => {
    const ledger = new BudgetLedger(fresh(), 1);
    const id = ledger.reserve('gpt-5.4-mini', 0.1, 't')!;
    ledger.release(id);
    expect(() => ledger.settle(id, 'estimate', 'usage')).toThrow();
    expect(() => ledger.reserve('some-other-model', 0.1, 't')).toThrow(/no price/);
  });

  it('a half-written temp file from a crash does not affect the ledger', () => {
    const path = fresh();
    const ledger = new BudgetLedger(path, 1);
    ledger.record('gpt-5.4-mini', 1000, 100);
    writeFileSync(`${path}.tmp-99999`, '{"budgetUsd": 1, "calls": [');
    expect(new BudgetLedger(path, 1).spent()).toBeCloseTo(0.0012);
  });
});
