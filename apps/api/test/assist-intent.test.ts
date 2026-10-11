// EP1 step 4: POST /assist/intent. The classifier is a stub here, so every outcome is
// reproducible. The point of these tests is what the APPLICATION does with a label.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { IntentClassifier } from '../src/assist/classifiers.js';
import { FALLBACK, nextStep } from '../src/assist/next-step.js';
import type { Intent } from '../src/assist/intent.js';
import { OrdersService } from '../src/orders/service.js';
import { orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

type Result = Awaited<ReturnType<IntentClassifier>>;
let next: Result = { classifier: 'llm', outcome: 'ok', intent: 'other', usage: { inputTokens: 0, outputTokens: 0 } };
const classify: IntentClassifier = async () => next;
const say = (intent: Intent) => { next = { classifier: 'llm', outcome: 'ok', intent, usage: { inputTokens: 1, outputTokens: 1 } }; };

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => { stack = await startStack({ classify }); });

const ask = (token: string | undefined, payload: unknown) =>
  stack.app.inject({ method: 'POST', url: '/assist/intent', payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const asRahul = async () => (await stack.login('rahul@tadka.test')).accessToken;

describe('access', () => {
  it('401 without a token, 403 for Owner and Admin, 400 for a bad body', async () => {
    expect((await ask(undefined, { text: 'hi' })).statusCode).toBe(401);
    for (const email of ['owner@tadka.test', 'admin@tadka.test']) {
      const res = await ask((await stack.login(email)).accessToken, { text: 'hi' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'customers_only' });
    }
    const t = await asRahul();
    expect((await ask(t, { text: '' })).statusCode).toBe(400);
    expect((await ask(t, { text: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await ask(t, {})).statusCode).toBe(400);
  });

  it('the body cannot carry an identity: a userId field is rejected', async () => {
    expect((await ask(await asRahul(), { text: 'hi', userId: IDS.aman })).statusCode).toBe(400);
  });
});

describe('order_status', () => {
  it("several active orders: lists the caller's own and asks which one", async () => {
    say('order_status');
    const body = (await ask(await asRahul(), { text: 'where is it' })).json();
    expect(body).toMatchObject({ outcome: 'ok', intent: 'order_status', next: { action: 'choose_order' } });
    const mine = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.rahul))).map((o) => o.id);
    expect(body.next.orders.length).toBeGreaterThan(1);
    for (const o of body.next.orders) expect(mine).toContain(o.orderId);
  });

  it('exactly one active order: reports its status', async () => {
    const all = await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman));
    const [keep, ...rest] = all;
    await stack.db.update(orders).set({ status: 'Delivered' }).where(inArray(orders.id, rest.map((o) => o.id)));
    say('order_status');
    const body = (await ask((await stack.login('aman@tadka.test')).accessToken, { text: 'status?' })).json();
    expect(body.next).toEqual({ action: 'order_status', order: { orderId: keep!.id, status: keep!.status } });
  });

  it('no active orders: says so', async () => {
    await stack.db.update(orders).set({ status: 'Cancelled' }).where(eq(orders.customerId, IDS.aman));
    say('order_status');
    const body = (await ask((await stack.login('aman@tadka.test')).accessToken, { text: 'status?' })).json();
    expect(body.next.action).toBe('no_active_orders');
  });

  it('a failing order lookup is a safe 500, never "no active orders"', async () => {
    const spy = vi.spyOn(OrdersService.prototype, 'listActive').mockRejectedValue(new Error('db down'));
    say('order_status');
    const res = await ask(await asRahul(), { text: 'status?' });
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
  });

  it('the service stub proves nextStep fails loudly', async () => {
    const stub = { listActive: async () => { throw new Error('db down'); } };
    await expect(nextStep({ userId: IDS.rahul, role: 'Customer' }, 'order_status', stub)).rejects.toThrow('db down');
  });
});

describe('labels that must not act', () => {
  it('cancel, refund, menu and other change nothing in the database', async () => {
    const before = JSON.stringify(await stack.db.select().from(orders).orderBy(orders.id));
    const t = await asRahul();
    const expected: Record<string, string> = { cancel_order: 'unsupported', refund_request: 'unsupported', menu_question: 'unsupported', other: 'clarify' };
    for (const [intent, action] of Object.entries(expected)) {
      say(intent as Intent);
      const body = (await ask(t, { text: 'cancel it and refund me' })).json();
      expect(body.next.action).toBe(action);
    }
    expect(JSON.stringify(await stack.db.select().from(orders).orderBy(orders.id))).toBe(before);
  });
});

describe('classification failures', () => {
  it('refusal and invalid_output: 200 with a safe fallback and the real outcome', async () => {
    for (const outcome of ['refusal', 'invalid_output'] as const) {
      next = { classifier: 'llm', outcome };
      const res = await ask(await asRahul(), { text: 'hi' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome, classifier: 'llm', next: FALLBACK });
    }
  });

  it('provider_error: 502 assistant_unavailable', async () => {
    next = { classifier: 'llm', outcome: 'provider_error', reason: 'budget' };
    const res = await ask(await asRahul(), { text: 'hi' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'assistant_unavailable' });
  });
});

describe('default classifier', () => {
  it('without a model, the app uses the keyword rules and says so', async () => {
    const plain = await startStack();
    const { accessToken } = await plain.login('rahul@tadka.test');
    const res = await plain.app.inject({ method: 'POST', url: '/assist/intent', payload: { text: 'Please cancel my order' }, headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.json()).toMatchObject({ outcome: 'ok', classifier: 'rules', intent: 'cancel_order', next: { action: 'unsupported' } });
  });
});
