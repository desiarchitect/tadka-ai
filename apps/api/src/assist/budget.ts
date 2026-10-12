// Hard spending cap for live probe calls. A provider-side alert only notifies; this
// refuses the call BEFORE it is sent if the worst case could cross the cap.
// Prices are per provider and model (src/llm/pricing.ts). A pair with no price is refused,
// so switching provider can never silently reuse another provider's numbers.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { PRICES, isPriced } from '../llm/pricing.js';

type Call = { at: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; reservationId?: string; chargedAt?: 'usage' | 'estimate' | 'operator' };
// A reservation holds a request's estimated cost against the cap until it is settled.
//   reserved -> released   the request never left (refused, or stopped before dispatch)
//   reserved -> sent       written just before the request leaves
//   sent     -> settled    actual usage known, or charged at the estimate
// A `sent` reservation is never released automatically: the provider may have processed it.
export type ReservationState = 'reserved' | 'sent' | 'settled' | 'released';
export type Reservation = { id: string; turnId: string; model: string; estimateUsd: number; state: ReservationState; createdAt: string };
type Ledger = { budgetUsd: number; calls: Call[]; reservations?: Reservation[] };

// The shared spending ledger: one JSON file, rewritten durably (temp file, fsync, rename)
// under an exclusive lock file. That is atomic for one or more processes on ONE machine.
// It is not atomic across containers or hosts; several API instances sharing one budget
// would need a database row updated in a transaction instead.
export class BudgetLedger {
  constructor(private readonly path: string, private readonly budgetUsd: number) {}

  read(): Ledger {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Ledger) : { budgetUsd: this.budgetUsd, calls: [] };
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
    const committed = this.committed();
    if (committed + worst > this.budgetUsd) throw new Error(`budget: committed $${committed.toFixed(6)} + worst case $${worst.toFixed(6)} exceeds cap $${this.budgetUsd}`);
    return worst;
  }

  record(model: string, inputTokens: number, outputTokens: number): number {
    return this.locked((l) => {
      const costUsd = BudgetLedger.cost(model, inputTokens, outputTokens);
      l.calls.push({ at: new Date().toISOString(), model, inputTokens, outputTokens, costUsd });
      return costUsd;
    });
  }

  // One locked compare-and-reserve. Returns null when the estimate doesn't fit, so two
  // concurrent turns can't both spend the same remaining allowance.
  reserve(model: string, estimateUsd: number, turnId: string): string | null {
    if (!isPriced(model)) throw new Error(`budget: no price configured for ${model}`);
    return this.locked((l) => {
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
      const r = this.transition(l, id, 'sent', 'settled');
      const model = r.model;
      const costUsd = charge === 'estimate' ? r.estimateUsd : BudgetLedger.cost(model, charge.inputTokens, charge.outputTokens);
      const tokens = charge === 'estimate' ? { inputTokens: 0, outputTokens: 0 } : charge;
      l.calls.push({ at: new Date().toISOString(), model, ...tokens, costUsd, reservationId: id, chargedAt: by });
      return costUsd;
    });
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
  private write(l: Ledger) {
    const tmp = `${this.path}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(l, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }
}
