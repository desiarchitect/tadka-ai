// EP2 step 3: the agent loop with a scripted fake model and in-memory services.
// No network, no key, no cost.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import type { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOP, estimateRequest, runTurn, type LoopConfig, type LoopDeps, type LoopEvent } from '../src/assist/agent-loop.js';
import { BudgetLedger } from '../src/assist/budget.js';
import { CLARIFY, FAILED, FALLBACK, NOT_FOUND } from '../src/assist/templates.js';
import { memoryAudit } from '../src/assist/tools/audit.js';
import type { ExecutorDeps } from '../src/assist/tools/executor.js';
import { NotFoundError } from '../src/shared/errors.js';
import { present, scripted, type Step } from './fake-model.js';
import type { Principal } from '../src/shared/principal.js';

const rahul: Principal = { userId: '11111111-1111-4111-8111-111111111111', role: 'Customer' };
const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const OWN = id(1), OWN2 = id(2), OWN3 = id(3), FOREIGN = id(8), INVENTED = id(9), BROKEN = id(7);
const REST = 'aaaaaaaa-0000-4000-8000-000000000001';
const order = (orderId: string, status = 'Preparing') => ({ id: orderId, restaurantId: REST, status, totalPaise: 59800, createdAt: new Date('2026-10-01T12:00:00Z') });

// ---- in-memory services ----
function services(opts: { delay?: (orderId: string) => number; onCall?: () => () => void } = {}) {
  const calls = { get: 0, listRecent: 0 };
  const orders = {
    listRecent: async () => { calls.listRecent++; return { orders: [order(OWN), order(OWN2, 'Delivered')], hasMore: false }; },
    get: async (_p: Principal, orderId: string) => {
      calls.get++;
      const done = opts.onCall?.();
      await new Promise((r) => setTimeout(r, opts.delay?.(orderId) ?? 0));
      done?.();
      if (orderId === BROKEN) throw new Error('db down');
      if ([OWN, OWN2, OWN3].includes(orderId)) return order(orderId);
      throw new NotFoundError('order_not_found', { denied: orderId === FOREIGN });
    },
  };
  const restaurants = {
    menuPage: async () => ({ restaurant: { id: REST, name: 'Spice Garden', city: 'Pune' }, items: [{ id: id(5), name: 'Butter Naan', pricePaise: 4900 }], totalItems: 1 }),
  };
  return { orders, restaurants, calls };
}

const config = (over: Partial<LoopConfig> = {}): LoopConfig => ({ ...DEFAULT_LOOP, priceKey: 'azure:gpt-5.4-mini', maxOutputTokens: 400, turnBudgetUsd: 0.05, estimateMargin: 1.25, ...over });
const ledgerPath = () => join(mkdtempSync(join(tmpdir(), 'loop-')), 'usage.json');
function setup(steps: Step[], over: { config?: Partial<LoopConfig>; svc?: ReturnType<typeof services>; ledger?: BudgetLedger } = {}) {
  const svc = over.svc ?? services();
  const audit = memoryAudit();
  const toolLogs: unknown[] = [];
  const events: LoopEvent[] = [];
  const model = scripted(steps);
  const executor: ExecutorDeps = { orders: svc.orders as never, restaurants: svc.restaurants as never, audit, log: (l) => toolLogs.push(l) };
  const ledger = over.ledger ?? new BudgetLedger(ledgerPath(), 5);
  const deps: LoopDeps = { model, providerOptions: {}, executor, ledger, config: config(over.config), log: (e) => events.push(e) };
  return { deps, model, svc, audit, toolLogs, events, ledger, run: (text = 'where is my order?') => runTurn(deps, rahul, text) };
}
const toolMessage = (model: MockLanguageModelV4, call: number) => {
  const prompt = model.doGenerateCalls[call]!.prompt;
  return prompt[prompt.length - 1] as unknown as { role: string; content: { toolCallId: string; output: { value: { resultId: string; status: string; data?: { order?: { orderId: string } } } } }[] };
};

describe('the loop answers from tool results only', () => {
  it('multi-step: latest order, then that restaurant\'s menu, rendered from templates', async () => {
    const t = setup([{ calls: [['get_my_orders', {}]] }, { calls: [['get_restaurant_menu', { restaurantId: REST }]] }, { calls: [present('r1', 'r2')] }]);
    const r = await t.run('what is my latest order and what is on the menu there?');
    expect(r.stopReason).toBe('answered');
    expect(r.answer).toContain('Your recent orders, newest first:');
    expect(r.answer).toContain('- 00000001: being prepared, Rs 598.00, placed on 2026-10-01');
    expect(r.answer).toContain('Spice Garden (Pune) menu:\n- Butter Naan: Rs 49.00');
    expect(r.steps).toEqual([{ tool: 'get_my_orders', status: 'ok' }, { tool: 'get_restaurant_menu', status: 'ok' }]);
  });

  it('an invented id: not_found, and the answer claims no status', async () => {
    const t = setup([{ calls: [['get_order', { orderId: INVENTED }]] }, { calls: [present('r1')] }]);
    const r = await t.run();
    expect(r.answer).toBe(NOT_FOUND.get_order);
    expect(r.answer).not.toMatch(/prepar|deliver|cancel|confirm|placed/i);
  });

  it("someone else's order looks exactly like an invented one, except in the audit channel", async () => {
    const a = setup([{ calls: [['get_order', { orderId: FOREIGN }]] }, { calls: [present('r1')] }]);
    const b = setup([{ calls: [['get_order', { orderId: INVENTED }]] }, { calls: [present('r1')] }]);
    const [ra, rb] = [await a.run(), await b.run()];
    expect(ra.answer).toBe(rb.answer);
    expect(ra.steps).toEqual(rb.steps);
    expect(a.toolLogs).toEqual(b.toolLogs);
    expect(toolMessage(a.model, 1).content[0]!.output.value).toEqual(toolMessage(b.model, 1).content[0]!.output.value);
    expect(a.audit.events).toHaveLength(1);
    expect(b.audit.events).toHaveLength(0);
  });

  it('a timeout, a failure or not_found never produces a retrieved status', async () => {
    const t = setup([{ calls: [['get_order', { orderId: BROKEN }]] }, { calls: [present('r1')] }]);
    expect((await t.run()).answer).toBe(FAILED);
  });

  it('a backend failure and "no order" stay distinct', async () => {
    const failed = await setup([{ calls: [['get_order', { orderId: BROKEN }]] }, { calls: [present('r1')] }]).run();
    const missing = await setup([{ calls: [['get_order', { orderId: INVENTED }]] }, { calls: [present('r1')] }]).run();
    expect(failed.answer).not.toBe(missing.answer);
  });
});

describe('the model never writes the reply', () => {
  it('prose instead of a tool call, twice, is invalid_output; the prose never reaches the user', async () => {
    const t = setup([{ text: 'Your order has been dispatched!' }, { text: 'Your order has been dispatched!' }]);
    const r = await t.run();
    expect(r.stopReason).toBe('invalid_output');
    expect(r.answer).toBe(FALLBACK);
  });

  it('presenting a result that does not exist, or one that was rejected, is invalid_output', async () => {
    expect((await setup([{ calls: [present('r7')] }]).run()).stopReason).toBe('invalid_output');
    const rejected = setup([{ calls: [['get_order', { orderId: 'nope' }]] }, { calls: [present('r1')] }]);
    expect((await rejected.run()).stopReason).toBe('invalid_output');
  });

  it('clarify renders a fixed question', async () => {
    const r = await setup([{ calls: [['final_answer', { kind: 'clarify', resultIds: [], clarifyReason: 'which_order' }]] }]).run();
    expect(r).toMatchObject({ stopReason: 'clarify', answer: CLARIFY.which_order });
  });

  it('every reply comes from the template set', async () => {
    const t = setup([{ calls: [['get_my_orders', {}], ['get_order', { orderId: BROKEN }], ['get_order', { orderId: INVENTED }]] }, { calls: [present('r1', 'r2', 'r3')] }]);
    const parts = (await t.run()).answer.split('\n\n');
    expect(parts[0]).toMatch(/^Your recent orders, newest first:\n(- [0-9a-f]{8}: [a-z ]+, Rs \d+\.\d\d, placed on \d{4}-\d\d-\d\d\n?)+$/);
    expect(parts.slice(1)).toEqual([FAILED, NOT_FOUND.get_order]);
  });
});

describe('history: one result per call id', () => {
  it('parallel calls that finish out of order keep their own call ids', async () => {
    const delays: Record<string, number> = { [OWN]: 60, [OWN2]: 5, [OWN3]: 30 };
    const svc = services({ delay: (o) => delays[o] ?? 0 });
    const t = setup([{ calls: [['get_order', { orderId: OWN }, 'a'], ['get_order', { orderId: OWN2 }, 'b'], ['get_order', { orderId: OWN3 }, 'c']] }, { calls: [present('r1')] }], { svc });
    await t.run();
    const msg = toolMessage(t.model, 1);
    expect(msg.role).toBe('tool');
    expect(msg.content.map((c) => [c.toolCallId, c.output.value.data?.order?.orderId])).toEqual([['a', OWN], ['b', OWN2], ['c', OWN3]]);
  });

  it('a partial failure keeps the successful result and reports the failed one', async () => {
    const t = setup([{ calls: [['get_order', { orderId: OWN }], ['get_order', { orderId: BROKEN }]] }, { calls: [present('r1', 'r2')] }]);
    const r = await t.run();
    expect(r.steps.map((s) => s.status)).toEqual(['ok', 'failed']);
    expect(toolMessage(t.model, 1).content.map((c) => c.output.value.status)).toEqual(['ok', 'failed']);
    expect(r.answer).toContain('being prepared');
    expect(r.answer).toContain(FAILED);
  });

  it('runs at most 3 tool calls at once', async () => {
    let now = 0, max = 0;
    const svc = services({ delay: () => 20, onCall: () => { now++; max = Math.max(max, now); return () => { now--; }; } });
    const calls = [OWN, OWN2, OWN3, INVENTED, FOREIGN].map((o) => ['get_order', { orderId: o }] as [string, unknown]);
    await setup([{ calls }, { calls: [present('r1')] }], { svc }).run();
    expect(max).toBe(3);
  });
});

describe('limits, each enforced on its own', () => {
  it('step limit: six model requests, then stop', async () => {
    const t = setup([{ calls: [['get_order', { orderId: OWN }]] }], { config: { maxToolCalls: 50 } });
    const r = await t.run();
    expect(r.stopReason).toBe('step_limit');
    expect(t.model.doGenerateCalls.length).toBe(6);
  });

  it('tool-call limit: the round that would pass 8 calls is not executed', async () => {
    const three = { calls: [OWN, OWN2, OWN3].map((o) => ['get_order', { orderId: o }] as [string, unknown]) };
    const t = setup([three, three, three]);
    const r = await t.run();
    expect(r.stopReason).toBe('tool_call_limit');
    expect(t.svc.calls.get).toBe(6);
  });

  it('two malformed rounds in a row (unknown tools) give the safe fallback', async () => {
    const r = await setup([{ calls: [['delete_order', {}]] }, { calls: [['delete_order', {}]] }]).run();
    expect(r).toMatchObject({ stopReason: 'invalid_output', answer: FALLBACK });
  });

  it('a filtered response is a refusal', async () => {
    expect((await setup([{ text: '', finish: 'content-filter' }]).run()).stopReason).toBe('refusal');
  });
});

describe('deadline (one per turn)', () => {
  it('a slow tool stops the turn at the deadline; the late result is discarded', async () => {
    const svc = services({ delay: (o) => (o === OWN ? 2000 : 0) });
    const t = setup([{ calls: [['get_order', { orderId: OWN }], ['get_order', { orderId: OWN2 }]] }, { calls: [present('r1')] }], { svc, config: { deadlineMs: 200 } });
    const started = Date.now();
    const r = await t.run();
    expect(r.stopReason).toBe('deadline');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t.model.doGenerateCalls.length).toBe(1);
  });

  it('a model request that exceeds the deadline', async () => {
    const t = setup([{ calls: [present('r1')], delayMs: 2000 }], { config: { deadlineMs: 200 } });
    const r = await t.run();
    expect(r).toMatchObject({ stopReason: 'deadline', answer: FALLBACK });
  });
});

describe('budget gate (section 3b)', () => {
  it('the configured output cap is sent on every request', async () => {
    const t = setup([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }], { config: { maxOutputTokens: 321 } });
    await t.run();
    expect(t.model.doGenerateCalls.map((c) => c.maxOutputTokens)).toEqual([321, 321]);
    expect(t.model.doGenerateCalls.every((c) => c.temperature === 0)).toBe(true);
  });

  it('nothing is sent when the first estimate exceeds the turn cap', async () => {
    const t = setup([{ calls: [present('r1')] }], { config: { turnBudgetUsd: 0.000001 } });
    expect((await t.run()).stopReason).toBe('budget');
    expect(t.model.doGenerateCalls.length).toBe(0);
  });

  it('the next request is not sent when it no longer fits', async () => {
    const t = setup([{ calls: [['get_my_orders', {}]], usage: { in: 4000, out: 400 } }, { calls: [present('r1')] }]);
    const first = estimateRequest([{ role: 'user', content: 'where is my order?' }], t.deps.config);
    t.deps.config.turnBudgetUsd = first.usd * 1.5; // room for one request, not two
    const r = await t.run();
    expect(r.stopReason).toBe('budget');
    expect(t.model.doGenerateCalls.length).toBe(1);
  });

  it('missing usage is charged at the estimate, never zero', async () => {
    const t = setup([{ calls: [present('r9')], usage: {} }]);
    const r = await t.run();
    expect(r.chargedUsd).toBeGreaterThan(0);
    expect(r.chargedUsd).toBeCloseTo(r.estimatedUsd, 10);
  });

  it('usage above the estimate is charged at actual, logged, and stops the turn', async () => {
    const t = setup([{ calls: [['get_my_orders', {}]], usage: { in: 9_000_000, out: 20 } }, { calls: [present('r1')] }]);
    const r = await t.run();
    expect(r.stopReason).toBe('budget');
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ event: 'estimator_violation', inputTokens: 9_000_000 });
    expect(t.ledger.spent()).toBeCloseTo(BudgetLedger.cost('azure:gpt-5.4-mini', 9_000_000, 20));
  });

  it('an unpriced model sends nothing', async () => {
    const t = setup([{ calls: [present('r1')] }], { config: { priceKey: 'azure:mystery-model' } });
    expect((await t.run()).stopReason).toBe('budget');
    expect(t.model.doGenerateCalls.length).toBe(0);
  });

  it('two concurrent turns cannot both spend the same allowance in the shared ledger', async () => {
    const one = estimateRequest([{ role: 'user', content: 'where is my order?' }], config()).usd;
    const ledger = new BudgetLedger(ledgerPath(), one * 1.5);
    const [a, b] = await Promise.all([1, 2].map(() => setup([{ calls: [present('r9')], delayMs: 20 }], { ledger }).run()));
    expect([a!.stopReason, b!.stopReason].sort()).toEqual(['budget', 'invalid_output']);
    expect(ledger.ambiguous()).toEqual([]);
  });

  it('Devanagari input is estimated by bytes, not characters', () => {
    const hindi = 'मेरा ऑर्डर कहाँ है';
    const a = estimateRequest([{ role: 'user', content: hindi }], config());
    const b = estimateRequest([{ role: 'user', content: '' }], config());
    expect(a.payloadBytes - b.payloadBytes).toBe(Buffer.byteLength(hindi, 'utf8'));
    expect(Buffer.byteLength(hindi, 'utf8')).toBeGreaterThan(hindi.length * 2);
  });

  it('a provider error stops the turn without retrying or re-running a tool', async () => {
    const err = new APICallError({ message: 'rate limited', url: 'u', requestBodyValues: {}, statusCode: 429 });
    const t = setup([{ calls: [['get_order', { orderId: OWN }]] }, { calls: [], throws: err }]);
    const r = await t.run();
    expect(r.stopReason).toBe('provider_error');
    expect(t.model.doGenerateCalls.length).toBe(2);
    expect(t.svc.calls.get).toBe(1);
    expect(t.ledger.ambiguous()).toEqual([]); // charged at the estimate
  });
});

describe('payload cap (bytes) is separate from the budget (USD)', () => {
  it('over 32 KB stops with history_limit even with budget to spare, answering from what it has', async () => {
    // The cap fits the first request (instructions, tools, question) but not the second, which adds the orders result.
    const cap = estimateRequest([{ role: 'user', content: 'x' }], setup([]).deps.config).payloadBytes + 150;
    const t = setup([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }], { config: { maxPayloadBytes: cap, turnBudgetUsd: 100 } });
    const r = await t.run();
    expect(r.stopReason).toBe('history_limit');
    expect(r.answer).toContain('Your recent orders');
  });

  it('under the payload cap but over budget stops with budget', async () => {
    const r = await setup([{ calls: [present('r1')] }], { config: { turnBudgetUsd: 0.000001 } }).run();
    expect(r.stopReason).toBe('budget');
  });
});
