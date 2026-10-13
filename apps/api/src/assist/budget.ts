// Hard spending cap for live probe calls. A provider-side alert only notifies; this
// refuses the call BEFORE it is sent if the worst case could cross the cap.
// Prices are per provider and model (src/llm/pricing.ts). A pair with no price is refused,
// so switching provider can never silently reuse another provider's numbers.
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { PRICES, isPriced } from '../llm/pricing.js';

type Call = {
  at: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; reservationId?: string;
  chargedAt?: 'usage' | 'estimate' | 'operator';
  /** The provider's usage figure was malformed or implausible, so this call was charged at a conservative figure instead. */
  usageRejected?: UsageProblem;
};

// What a usage figure from a provider must look like before it is allowed into the accounts.
// The bounds are deliberately explicit and generous for a single request of this application; a figure outside them
// is not "a big request", it is a wrong number, and it is never written down as if it were true.
export const USAGE_BOUNDS = { maxInputTokens: 1_000_000, maxOutputTokens: 100_000 } as const;
export type UsageProblem = 'not_a_number' | 'negative' | 'not_an_integer' | 'above_absolute_bound' | 'above_request_bound';
/** Per-request bounds, known before the request is sent (what this request could possibly have used). */
export type UsageLimits = { maxInputTokens?: number; maxOutputTokens?: number };
export type UsageCheck = { ok: true; inputTokens: number; outputTokens: number } | { ok: false; reason: UsageProblem };

export function checkUsage(usage: { inputTokens: unknown; outputTokens: unknown }, limits: UsageLimits = {}): UsageCheck {
  const { inputTokens: i, outputTokens: o } = usage;
  if (typeof i !== 'number' || typeof o !== 'number' || !Number.isFinite(i) || !Number.isFinite(o)) return { ok: false, reason: 'not_a_number' };
  if (i < 0 || o < 0) return { ok: false, reason: 'negative' };
  if (!Number.isInteger(i) || !Number.isInteger(o)) return { ok: false, reason: 'not_an_integer' };
  if (i > USAGE_BOUNDS.maxInputTokens || o > USAGE_BOUNDS.maxOutputTokens) return { ok: false, reason: 'above_absolute_bound' };
  if ((limits.maxInputTokens !== undefined && i > limits.maxInputTokens) || (limits.maxOutputTokens !== undefined && o > limits.maxOutputTokens)) return { ok: false, reason: 'above_request_bound' };
  return { ok: true, inputTokens: i, outputTokens: o };
}

/** Why live calls are blocked. Set by the ledger itself; cleared only by an operator (scripts/budget.ts clear-halt). */
export type Halt = { at: string; reason: string; model?: string; reservationId?: string };
/** An append-only record of what the ledger did and what an operator did to it. */
export type LedgerEvent = { at: string; event: string; [k: string]: unknown };

/** The ledger file exists but cannot be trusted. Nothing is spent until an operator deals with it. */
export class LedgerCorruptError extends Error {
  constructor(readonly path: string, detail: string) { super(`budget: the ledger file ${path} is corrupt (${detail}). Live calls are blocked. See RUNBOOK, "Ledger recovery".`); this.name = 'LedgerCorruptError'; }
}
/** Live calls are blocked until an operator reviews why (see `halted`). */
export class LedgerHaltedError extends Error {
  constructor(readonly halt: Halt) { super(`budget: live calls are blocked since ${halt.at} (${halt.reason}). An operator must review the ledger first. See RUNBOOK, "Ledger recovery".`); this.name = 'LedgerHaltedError'; }
}
// A reservation holds a request's estimated cost against the cap until it is settled.
//   reserved -> released   the request never left (refused, or stopped before dispatch)
//   reserved -> sent       written just before the request leaves
//   sent     -> settled    actual usage known, or charged at the estimate
// A `sent` reservation is never released automatically: the provider may have processed it.
export type ReservationState = 'reserved' | 'sent' | 'settled' | 'released';
export type Reservation = { id: string; turnId: string; model: string; estimateUsd: number; state: ReservationState; createdAt: string };
type Ledger = { budgetUsd: number; calls: Call[]; reservations?: Reservation[]; halted?: Halt; events?: LedgerEvent[] };

// The shared spending ledger: one JSON file, rewritten durably (temp file, fsync, rename)
// under an exclusive lock file. That is atomic for one or more processes on ONE machine.
// It is not atomic across containers or hosts; several API instances sharing one budget
// would need a database row updated in a transaction instead.
export class BudgetLedger {
  constructor(private readonly path: string, private readonly budgetUsd: number) {}

  // A ledger that cannot be parsed, or whose figures are not sane, is not "empty": it throws LedgerCorruptError and
  // every spending path refuses. It is never silently replaced (that would forget what was spent).
  read(): Ledger {
    if (!existsSync(this.path)) return { budgetUsd: this.budgetUsd, calls: [] };
    let l: unknown;
    try { l = JSON.parse(readFileSync(this.path, 'utf8')); } catch (e) { throw new LedgerCorruptError(this.path, `not valid JSON: ${(e as Error).message.slice(0, 80)}`); }
    const bad = ledgerProblem(l);
    if (bad) throw new LedgerCorruptError(this.path, bad);
    return l as Ledger;
  }

  /** The block that is in force, if any. A corrupt file counts as blocked (it throws). */
  halted(): Halt | undefined {
    return this.read().halted;
  }

  // Money already charged.
  spent(): number {
    return this.read().calls.reduce((s, c) => s + c.costUsd, 0);
  }

  // Charged plus everything still held by a reserved or sent request.
  committed(l: Ledger = this.read()): number {
    const open = (l.reservations ?? []).filter((r) => r.state === 'reserved' || r.state === 'sent');
    return l.calls.reduce((s, c) => s + c.costUsd, 0) + open.reduce((s, r) => s + r.estimateUsd, 0);
  }

  // `model` is a price key such as "azure:gpt-5.4-mini" (ModelHandle.priceKey).
  static cost(model: string, inputTokens: number, outputTokens: number): number {
    if (!isPriced(model)) throw new Error(`budget: no price configured for ${model}`);
    const p = PRICES[model]!;
    return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
  }

  // Worst case: the caller's estimate of input tokens, plus the full output cap, priced
  // separately. An unpriced model throws here, so the guard fails closed.
  assertAffordable(model: string, inputTokensEstimate: number, maxOutputTokens: number): number {
    if (!isPriced(model)) throw new Error(`budget: no price configured for ${model}`);
    const worst = BudgetLedger.cost(model, inputTokensEstimate, maxOutputTokens);
    const l = this.read();
    if (l.halted) throw new LedgerHaltedError(l.halted);
    const committed = this.committed(l);
    if (committed + worst > this.budgetUsd) throw new Error(`budget: committed $${committed.toFixed(6)} + worst case $${worst.toFixed(6)} exceeds cap $${this.budgetUsd}`);
    return worst;
  }

  // Writes down one finished call. The usage is checked first (checkUsage). A figure that fails the check is not recorded:
  // the call is charged at the worst case its limits allow (the absolute bounds if none were given), and live calls are
  // blocked until an operator has looked at it. Spend that cannot be established is assumed to be the worst, not zero.
  record(model: string, inputTokens: number, outputTokens: number, limits: UsageLimits = {}): number {
    return this.locked((l) => {
      const check = checkUsage({ inputTokens, outputTokens }, limits);
      if (check.ok) {
        const costUsd = BudgetLedger.cost(model, check.inputTokens, check.outputTokens);
        l.calls.push({ at: new Date().toISOString(), model, inputTokens: check.inputTokens, outputTokens: check.outputTokens, costUsd });
        return costUsd;
      }
      const costUsd = BudgetLedger.cost(model, limits.maxInputTokens ?? USAGE_BOUNDS.maxInputTokens, limits.maxOutputTokens ?? USAGE_BOUNDS.maxOutputTokens);
      l.calls.push({ at: new Date().toISOString(), model, inputTokens: 0, outputTokens: 0, costUsd, chargedAt: 'estimate', usageRejected: check.reason });
      this.halt(l, `usage_rejected:${check.reason}`, model);
      return costUsd;
    });
  }

  // One locked compare-and-reserve. Returns null when the estimate doesn't fit, so two
  // concurrent turns can't both spend the same remaining allowance.
  reserve(model: string, estimateUsd: number, turnId: string): string | null {
    if (!isPriced(model)) throw new Error(`budget: no price configured for ${model}`);
    return this.locked((l) => {
      if (l.halted) return null; // blocked until an operator clears it: refuse, like a full budget
      if (this.committed(l) + estimateUsd > this.budgetUsd) return null;
      const id = randomUUID();
      (l.reservations ??= []).push({ id, turnId, model, estimateUsd, state: 'reserved', createdAt: new Date().toISOString() });
      return id;
    });
  }

  markSent(id: string) {
    this.locked((l) => { this.transition(l, id, 'reserved', 'sent'); });
  }

  release(id: string) {
    this.locked((l) => { this.transition(l, id, 'reserved', 'released'); });
  }

  // Compare-and-set from `sent` to `settled`, once. Settling an unknown, released or
  // already-settled reservation throws and changes nothing, so a charge can't apply twice.
  settle(id: string, charge: { inputTokens: number; outputTokens: number } | 'estimate', by: 'usage' | 'estimate' | 'operator'): number {
    return this.locked((l) => {
      if (charge !== 'estimate') {
        const check = checkUsage(charge); // an operator typo must not become an accounting entry either
        if (!check.ok) throw new Error(`budget: those usage figures are not acceptable (${check.reason})`);
      }
      const r = this.transition(l, id, 'sent', 'settled');
      const model = r.model;
      const costUsd = charge === 'estimate' ? r.estimateUsd : BudgetLedger.cost(model, charge.inputTokens, charge.outputTokens);
      const tokens = charge === 'estimate' ? { inputTokens: 0, outputTokens: 0 } : charge;
      l.calls.push({ at: new Date().toISOString(), model, ...tokens, costUsd, reservationId: id, chargedAt: by });
      return costUsd;
    });
  }

  // The turn loop's way to settle a finished request from what the provider reported. The ledger, not the caller, decides
  // whether the figure may be believed:
  //   missing (no figures at all, or only one)  charged at the estimate held, as before; nothing else changes
  //   valid and within `limits`                 charged at the real usage
  //   malformed or implausible                  NOT written down; charged at the estimate held, live calls blocked,
  //                                             the reason kept on the call and in the events
  settleUsage(id: string, usage: { inputTokens?: unknown; outputTokens?: unknown } | undefined, limits: UsageLimits): { costUsd: number; accepted: boolean; reason?: UsageProblem } {
    return this.locked((l) => {
      const r = this.transition(l, id, 'sent', 'settled');
      const at = new Date().toISOString();
      const missing = usage === undefined || usage.inputTokens === undefined || usage.outputTokens === undefined;
      if (missing) {
        l.calls.push({ at, model: r.model, inputTokens: 0, outputTokens: 0, costUsd: r.estimateUsd, reservationId: id, chargedAt: 'estimate' });
        return { costUsd: r.estimateUsd, accepted: true };
      }
      const check = checkUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, limits);
      if (check.ok) {
        const costUsd = BudgetLedger.cost(r.model, check.inputTokens, check.outputTokens);
        l.calls.push({ at, model: r.model, inputTokens: check.inputTokens, outputTokens: check.outputTokens, costUsd, reservationId: id, chargedAt: 'usage' });
        return { costUsd, accepted: true };
      }
      l.calls.push({ at, model: r.model, inputTokens: 0, outputTokens: 0, costUsd: r.estimateUsd, reservationId: id, chargedAt: 'estimate', usageRejected: check.reason });
      this.halt(l, `usage_rejected:${check.reason}`, r.model, id);
      return { costUsd: r.estimateUsd, accepted: false, reason: check.reason };
    });
  }

  private halt(l: Ledger, reason: string, model?: string, reservationId?: string) {
    const at = new Date().toISOString();
    (l.events ??= []).push({ at, event: 'halted', reason, ...(model ? { model } : {}), ...(reservationId ? { reservationId } : {}) });
    l.halted ??= { at, reason, ...(model ? { model } : {}), ...(reservationId ? { reservationId } : {}) }; // the first reason stays
  }

  // ---- Operator recovery. Never called by the application itself; see scripts/budget.ts and the RUNBOOK. ----

  /**
   * Lifts a block. Explicit and recorded: a reason is required, a byte-for-byte copy of the ledger is saved first (the
   * evidence), and the block, the reason and who cleared it stay in the events. Spending history is not touched.
   */
  clearHalt(reason: string): { evidencePath: string } {
    if (reason.trim().length < 10) throw new Error('budget: clearing a block needs a reason of at least 10 characters');
    return this.locked((l) => {
      if (!l.halted) throw new Error('budget: there is no block to clear');
      const evidencePath = this.keepEvidence('halt-cleared');
      (l.events ??= []).push({ at: new Date().toISOString(), event: 'halt_cleared', reason: reason.trim(), clearedBlock: l.halted, operator: operatorName(), evidencePath });
      delete l.halted;
      return { evidencePath };
    });
  }

  /**
   * For a ledger file that is corrupt: moves it aside (kept, never deleted) and starts a new one whose opening balance is
   * the amount the operator established from the provider's own billing. There is no default: zero must be said out loud.
   */
  static quarantineCorrupt(path: string, budgetUsd: number, baselineSpentUsd: number, reason: string): { evidencePath: string } {
    if (reason.trim().length < 10) throw new Error('budget: starting over needs a reason of at least 10 characters');
    if (!Number.isFinite(baselineSpentUsd) || baselineSpentUsd < 0) throw new Error('budget: the baseline spend must be a number of dollars, 0 or more');
    if (!existsSync(path)) throw new Error('budget: there is no ledger file to move aside');
    const ledger = new BudgetLedger(path, budgetUsd);
    try { ledger.read(); throw new Error('budget: that ledger file is not corrupt; use clear-halt or settle instead'); } catch (e) { if (!(e instanceof LedgerCorruptError)) throw e; }
    const evidencePath = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(path, evidencePath);
    const at = new Date().toISOString();
    const fresh: Ledger = {
      budgetUsd,
      calls: [{ at, model: 'operator-baseline', inputTokens: 0, outputTokens: 0, costUsd: baselineSpentUsd, chargedAt: 'operator' }],
      events: [{ at, event: 'restarted_from_corrupt', reason: reason.trim(), baselineSpentUsd, operator: operatorName(), evidencePath }],
    };
    ledger.write(fresh);
    return { evidencePath };
  }

  // A copy of the file as it is now, next to it, never overwritten.
  private keepEvidence(label: string): string {
    const evidencePath = `${this.path}.evidence-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(this.path, evidencePath, 1 /* COPYFILE_EXCL: refuse to overwrite */);
    return evidencePath;
  }

  // On start: a `reserved` entry never left, so it is released. A `sent` entry without a
  // settlement is ambiguous and stays held at its full estimate until an operator settles it.
  reconcile(): { released: number; ambiguous: Reservation[] } {
    return this.locked((l) => {
      let released = 0;
      for (const r of l.reservations ?? []) if (r.state === 'reserved') { r.state = 'released'; released++; }
      return { released, ambiguous: (l.reservations ?? []).filter((r) => r.state === 'sent') };
    });
  }

  ambiguous(): Reservation[] {
    return (this.read().reservations ?? []).filter((r) => r.state === 'sent');
  }

  private transition(l: Ledger, id: string, from: ReservationState, to: ReservationState): Reservation {
    const r = (l.reservations ?? []).find((x) => x.id === id);
    if (!r) throw new Error(`budget: unknown reservation ${id}`);
    if (r.state !== from) throw new Error(`budget: reservation ${id} is ${r.state}, not ${from}`);
    r.state = to;
    return r;
  }

  private locked<T>(fn: (l: Ledger) => T): T {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 5000;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lock, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // A lock older than 30 s belongs to a process that died while holding it.
        try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch { /* gone already */ }
        if (Date.now() > deadline) throw new Error('budget: ledger is locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      const l = this.read();
      const out = fn(l);
      this.write(l);
      return out;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }

  // Durable replace: a crash mid-write leaves the old file intact.
  write(l: Ledger) {
    const tmp = `${this.path}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(l, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }
}

const operatorName = () => { try { return userInfo().username; } catch { return 'unknown'; } };

// Is this a ledger this code wrote? Anything else is corrupt. Figures must be finite and not negative: a ledger with a
// negative cost would quietly make room under the cap.
function ledgerProblem(l: unknown): string | null {
  if (typeof l !== 'object' || l === null || Array.isArray(l)) return 'not an object';
  const x = l as Record<string, unknown>;
  if (typeof x.budgetUsd !== 'number' || !Number.isFinite(x.budgetUsd)) return 'budgetUsd is not a number';
  if (!Array.isArray(x.calls)) return 'calls is not a list';
  for (const c of x.calls) {
    if (typeof c !== 'object' || c === null) return 'a call is not an object';
    const cost = (c as { costUsd?: unknown }).costUsd;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return 'a call has a cost that is not a number of dollars, 0 or more';
  }
  if (x.reservations !== undefined) {
    if (!Array.isArray(x.reservations)) return 'reservations is not a list';
    for (const r of x.reservations) {
      const e = (r as { estimateUsd?: unknown; state?: unknown } | null);
      if (!e || typeof e.estimateUsd !== 'number' || !Number.isFinite(e.estimateUsd) || e.estimateUsd < 0) return 'a reservation has an estimate that is not a number of dollars, 0 or more';
      if (!['reserved', 'sent', 'settled', 'released'].includes(String(e.state))) return 'a reservation has an unknown state';
    }
  }
  return null;
}
