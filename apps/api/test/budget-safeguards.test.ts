// O-1: what the spending ledger believes, what it refuses, and how an operator recovers it. Deterministic, no network, no cost.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { BudgetLedger, LedgerCorruptError, LedgerHaltedError, USAGE_BOUNDS, checkUsage } from '../src/assist/budget.js';

const MODEL = 'azure:gpt-5.4-mini';
const fresh = (cap = 1) => { const path = join(mkdtempSync(join(tmpdir(), 'safe-')), 'usage.json'); return { path, ledger: new BudgetLedger(path, cap) }; };
const sentReservation = (l: BudgetLedger, usd = 0.01) => { const id = l.reserve(MODEL, usd, 't')!; l.markSent(id); return id; };
const LIMITS = { maxInputTokens: 5_000, maxOutputTokens: 400 };

describe('usage is validated before it is recorded', () => {
  it.each([
    ['NaN', NaN, 10, 'not_a_number'],
    ['Infinity', Infinity, 10, 'not_a_number'],
    ['a string', '5' as unknown as number, 10, 'not_a_number'],
    ['undefined output', 1, undefined as unknown as number, 'not_a_number'],
    ['negative input', -1, 10, 'negative'],
    ['negative output', 10, -5, 'negative'],
    ['a fraction', 10.5, 10, 'not_an_integer'],
    ['above the absolute bound (input)', USAGE_BOUNDS.maxInputTokens + 1, 10, 'above_absolute_bound'],
    ['above the absolute bound (output)', 10, USAGE_BOUNDS.maxOutputTokens + 1, 'above_absolute_bound'],
    ['above this request\'s bound (input)', 5_001, 10, 'above_request_bound'],
    ['above this request\'s bound (output)', 100, 401, 'above_request_bound'],
  ])('%s is rejected', (_n, input, output, reason) => {
    expect(checkUsage({ inputTokens: input, outputTokens: output }, LIMITS)).toEqual({ ok: false, reason });
  });

  it('a normal figure, and one exactly at the bounds, are accepted', () => {
    expect(checkUsage({ inputTokens: 1200, outputTokens: 90 }, LIMITS)).toEqual({ ok: true, inputTokens: 1200, outputTokens: 90 });
    expect(checkUsage({ inputTokens: 5_000, outputTokens: 400 }, LIMITS).ok).toBe(true);
  });

  it('settleUsage: a rejected figure is charged at the ESTIMATE (never the wrong number, never zero), and live calls are blocked', () => {
    for (const bad of [{ inputTokens: NaN, outputTokens: 5 }, { inputTokens: -9, outputTokens: 5 }, { inputTokens: 9_000_000, outputTokens: 5 }, { inputTokens: 100, outputTokens: 999 }]) {
      const { ledger } = fresh(5);
      const id = sentReservation(ledger, 0.02);
      const out = ledger.settleUsage(id, bad, LIMITS);
      expect(out.accepted).toBe(false);
      expect(out.costUsd).toBe(0.02);
      expect(ledger.spent()).toBeCloseTo(0.02);
      const call = ledger.read().calls[0]!;
      expect(call).toMatchObject({ chargedAt: 'estimate', inputTokens: 0, outputTokens: 0 });
      expect(call.usageRejected).toBeTruthy();
      expect(ledger.halted()?.reason).toMatch(/^usage_rejected:/);
    }
  });

  it('settleUsage: missing usage is charged at the estimate WITHOUT a block; valid usage is charged as reported', () => {
    const { ledger } = fresh(5);
    const a = sentReservation(ledger, 0.02);
    expect(ledger.settleUsage(a, undefined, LIMITS)).toEqual({ costUsd: 0.02, accepted: true });
    const b = sentReservation(ledger, 0.02);
    expect(ledger.settleUsage(b, { inputTokens: 1000, outputTokens: 100 }, LIMITS).costUsd).toBeCloseTo(BudgetLedger.cost(MODEL, 1000, 100));
    expect(ledger.halted()).toBeUndefined();
  });

  it('record(): a wrong figure is charged at the worst case its limits allow, and blocks live calls', () => {
    const { ledger } = fresh(5);
    expect(ledger.record(MODEL, 7_000, 10, LIMITS)).toBeCloseTo(BudgetLedger.cost(MODEL, 5_000, 400));
    expect(ledger.halted()?.reason).toBe('usage_rejected:above_request_bound');
    const other = fresh(5).ledger;
    expect(other.record(MODEL, NaN, 1)).toBeCloseTo(BudgetLedger.cost(MODEL, USAGE_BOUNDS.maxInputTokens, USAGE_BOUNDS.maxOutputTokens)); // no limits given: the absolute worst
  });

  it('an operator\'s settle with nonsense figures is refused and changes nothing', () => {
    const { ledger } = fresh(5);
    const id = sentReservation(ledger);
    expect(() => ledger.settle(id, { inputTokens: -1, outputTokens: 1 }, 'operator')).toThrow(/not acceptable/);
    expect(ledger.ambiguous().map((r) => r.id)).toEqual([id]); // still held, not settled
  });
});

describe('the cap stays fail-closed', () => {
  it('cap reached: no reservation, no affordable check', () => {
    const { ledger } = fresh(0.05);
    expect(ledger.reserve(MODEL, 0.04, 'a')).toBeTruthy();
    expect(ledger.reserve(MODEL, 0.04, 'b')).toBeNull();
    expect(() => ledger.assertAffordable(MODEL, 1_000_000, 100_000)).toThrow(/exceeds cap/);
  });

  it('a block refuses reserve() and assertAffordable() with a clear error, and survives restart and reconcile (never resets by itself)', () => {
    const { path, ledger } = fresh(5);
    ledger.settleUsage(sentReservation(ledger), { inputTokens: NaN, outputTokens: 1 }, LIMITS);
    expect(ledger.reserve(MODEL, 0.001, 'next')).toBeNull();
    expect(() => ledger.assertAffordable(MODEL, 10, 10)).toThrow(LedgerHaltedError);
    const restarted = new BudgetLedger(path, 5);
    restarted.reconcile();
    expect(restarted.halted()).toBeTruthy();
    expect(restarted.reserve(MODEL, 0.001, 'after restart')).toBeNull();
    expect(readFileSync(path, 'utf8')).toContain('"halted"');
  });

  it('in-flight requests can still be settled while blocked (their money is owed)', () => {
    const { ledger } = fresh(5);
    const inflight = sentReservation(ledger, 0.03);
    ledger.settleUsage(sentReservation(ledger), { inputTokens: -1, outputTokens: 1 }, LIMITS);
    expect(ledger.settleUsage(inflight, { inputTokens: 100, outputTokens: 10 }, LIMITS).accepted).toBe(true);
  });

  it('concurrent turns: only what fits is reserved, and a halt raised mid-way stops the rest', () => {
    const { ledger } = fresh(0.1);
    const ids = Array.from({ length: 6 }, (_, i) => ledger.reserve(MODEL, 0.03, `t${i}`));
    expect(ids.filter(Boolean)).toHaveLength(3);
    expect(ledger.committed()).toBeCloseTo(0.09);
    ledger.markSent(ids[0]!);
    ledger.settleUsage(ids[0]!, { inputTokens: Infinity, outputTokens: 1 }, LIMITS);
    expect(ledger.reserve(MODEL, 0.001, 'late')).toBeNull();
  });
});

describe('a corrupt ledger is never treated as empty', () => {
  const corruptions: [string, string][] = [
    ['not JSON', '{"budgetUsd": 5, "calls": [ <<<<'],
    ['an empty file', ''],
    ['a list', '[]'],
    ['a negative cost (would make room under the cap)', JSON.stringify({ budgetUsd: 5, calls: [{ at: 'x', model: MODEL, inputTokens: 1, outputTokens: 1, costUsd: -4 }] })],
    ['a cost that is not a number', JSON.stringify({ budgetUsd: 5, calls: [{ costUsd: '3' }] })],
    ['calls missing', JSON.stringify({ budgetUsd: 5 })],
    ['a reservation in an unknown state', JSON.stringify({ budgetUsd: 5, calls: [], reservations: [{ estimateUsd: 1, state: 'weird' }] })],
  ];
  it.each(corruptions)('%s: every spending path refuses', (_n, content) => {
    const { path, ledger } = fresh(5);
    writeFileSync(path, content);
    expect(() => ledger.read()).toThrow(LedgerCorruptError);
    expect(() => ledger.reserve(MODEL, 0.01, 't')).toThrow(LedgerCorruptError);
    expect(() => ledger.assertAffordable(MODEL, 10, 10)).toThrow(LedgerCorruptError);
    expect(() => ledger.record(MODEL, 10, 10)).toThrow(LedgerCorruptError);
    expect(readFileSync(path, 'utf8')).toBe(content); // untouched: the evidence is still there
    expect(existsSync(`${path}.lock`)).toBe(false); // and the lock was released
  });
});

describe('operator recovery is explicit and leaves evidence', () => {
  const halted = () => { const t = fresh(5); const id = sentReservation(t.ledger); t.ledger.settleUsage(id, { inputTokens: 99, outputTokens: -2 }, LIMITS); return t; };

  it('clearHalt needs a real reason, keeps a copy of the file as it was, records who and why, and leaves the spending alone', () => {
    const { path, ledger } = halted();
    const before = readFileSync(path, 'utf8');
    const spentBefore = ledger.spent();
    expect(() => ledger.clearHalt('ok')).toThrow(/at least 10 characters/);
    expect(ledger.halted()).toBeTruthy();
    const { evidencePath } = ledger.clearHalt('Checked Foundry billing for 12 Oct: no spend beyond the estimate');
    expect(readFileSync(evidencePath, 'utf8')).toBe(before); // byte for byte, as it was when it was blocked
    expect(ledger.halted()).toBeUndefined();
    expect(ledger.spent()).toBeCloseTo(spentBefore);
    const events = ledger.read().events!;
    expect(events.map((e) => e.event)).toEqual(['halted', 'halt_cleared']);
    expect(events[1]).toMatchObject({ reason: expect.stringContaining('Foundry billing'), evidencePath, clearedBlock: { reason: expect.stringContaining('usage_rejected') } });
    expect(ledger.reserve(MODEL, 0.001, 'again')).toBeTruthy(); // usable again, by an explicit act
  });

  it('there is nothing to clear when nothing is blocked', () => {
    expect(() => fresh().ledger.clearHalt('there is no reason to do this')).toThrow(/no block to clear/);
  });

  it('a corrupt file is moved aside (kept) and replaced only with an explicit baseline taken from the provider\'s billing', () => {
    const { path } = fresh(5);
    writeFileSync(path, '{ broken');
    expect(() => BudgetLedger.quarantineCorrupt(path, 5, NaN, 'provider billing says 1.2 dollars')).toThrow(/baseline/);
    expect(() => BudgetLedger.quarantineCorrupt(path, 5, -1, 'provider billing says 1.2 dollars')).toThrow(/baseline/);
    expect(() => BudgetLedger.quarantineCorrupt(path, 5, 1.2, 'short')).toThrow(/reason/);
    expect(readFileSync(path, 'utf8')).toBe('{ broken'); // nothing happened yet
    const { evidencePath } = BudgetLedger.quarantineCorrupt(path, 5, 1.2, 'provider billing says 1.2 dollars');
    expect(readFileSync(evidencePath, 'utf8')).toBe('{ broken'); // the corrupt original, preserved
    const fresh2 = new BudgetLedger(path, 5);
    expect(fresh2.spent()).toBeCloseTo(1.2); // the new accounting starts from the stated baseline, not from zero
    expect(fresh2.read().events![0]).toMatchObject({ event: 'restarted_from_corrupt', baselineSpentUsd: 1.2, evidencePath });
    expect(readdirSync(dirname(path)).filter((f) => f.startsWith(`${basename(path)}.corrupt-`))).toHaveLength(1);
  });

  it('it refuses to "start over" a ledger that is not corrupt, or a file that does not exist', () => {
    const { path, ledger } = fresh(5);
    expect(() => BudgetLedger.quarantineCorrupt(path, 5, 0, 'a perfectly good reason')).toThrow(/no ledger file/);
    ledger.reserve(MODEL, 0.01, 't');
    expect(() => BudgetLedger.quarantineCorrupt(path, 5, 0, 'a perfectly good reason')).toThrow(/not corrupt/);
  });
});

describe('the operator command', () => {
  const run = promisify(execFile);
  const script = fileURLToPath(new URL('../scripts/budget.ts', import.meta.url));
  const cmd = (path: string, ...args: string[]) =>
    run(process.execPath, ['--import', 'tsx', script, ...args], { env: { ...process.env, M0_LEDGER_PATH: path, M0_BUDGET_USD: '5' } })
      .then((r) => ({ code: 0, out: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }));

  it('status shows the block; clear-halt without --confirm or a reason changes nothing; with both it clears and says where the evidence is', async () => {
    const { path, ledger } = fresh(5);
    ledger.settleUsage(sentReservation(ledger), { inputTokens: NaN, outputTokens: 1 }, LIMITS);
    expect((await cmd(path, 'status')).out).toMatch(/BLOCKED.*usage_rejected:not_a_number/s);
    expect((await cmd(path, 'clear-halt', '--reason', 'I looked at the billing page today')).code).toBe(2); // no --confirm
    expect((await cmd(path, 'clear-halt', '--confirm')).code).toBe(2); // no reason
    expect(ledger.halted()).toBeTruthy();
    const ok = await cmd(path, 'clear-halt', '--reason', 'I looked at the billing page today', '--confirm');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/evidence/);
    expect(ledger.halted()).toBeUndefined();
  }, 60_000);

  it('start-over for a corrupt ledger needs --baseline-spent-usd, --reason and --confirm', async () => {
    const { path } = fresh(5);
    writeFileSync(path, 'garbage');
    expect((await cmd(path, 'status')).out).toMatch(/CORRUPT/);
    expect((await cmd(path, 'start-over', '--reason', 'file is garbage, billing says 0.4', '--confirm')).code).toBe(2); // no baseline
    expect(readFileSync(path, 'utf8')).toBe('garbage');
    const ok = await cmd(path, 'start-over', '--baseline-spent-usd', '0.4', '--reason', 'file is garbage, billing says 0.4', '--confirm');
    expect(ok.code).toBe(0);
    expect(new BudgetLedger(path, 5).spent()).toBeCloseTo(0.4);
  }, 60_000);
});
