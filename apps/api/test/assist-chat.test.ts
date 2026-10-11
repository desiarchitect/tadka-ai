// EP2 step 4: POST /assist/chat end to end, with the real database and a scripted model.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LOOP } from '../src/assist/agent-loop.js';
import { BudgetLedger } from '../src/assist/budget.js';
import { NOT_FOUND } from '../src/assist/templates.js';
import { memoryAudit } from '../src/assist/tools/audit.js';
import { orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { present, scripted, type Step } from './fake-model.js';
import { startStack } from './helpers.js';

// One stack; each test swaps in its own script.
const model = scripted([]);
const use = (steps: Step[]) => { const inner = scripted(steps); model.doGenerate = (opts) => inner.doGenerate(opts); };
const audit = memoryAudit();
const assistant = {
  model, audit,
  ledger: new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'chat-')), 'usage.json'), 5),
  config: { ...DEFAULT_LOOP, pricedModel: 'gpt-5.4-mini', maxOutputTokens: 400, turnBudgetUsd: 0.05, estimateMargin: 1.25 },
};

let stack: Awaited<ReturnType<typeof startStack>>;
let amanOrderId: string;
let rahul: string;
beforeAll(async () => {
  stack = await startStack({ assistant });
  amanOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman)))[0]!.id;
  rahul = (await stack.login('rahul@tadka.test')).accessToken;
});

const chat = (token: string | undefined, payload: unknown) =>
  stack.app.inject({ method: 'POST', url: '/assist/chat', payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('POST /assist/chat', () => {
  it("answers from Rahul's own orders", async () => {
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }]);
    const res = await chat(rahul, { text: 'mera latest order kahan hai?' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['answer', 'steps', 'stopReason']);
    expect(res.json()).toMatchObject({ stopReason: 'answered', steps: [{ tool: 'get_my_orders', status: 'ok' }] });
    expect(res.json().answer).toMatch(/^Your recent orders, newest first:/);
    expect(res.json().answer).not.toMatch(/Test Lane|Sample Road/);
  });

  it("Aman's order id in Rahul's chat: not found, nothing about the order, one audit event", async () => {
    use([{ calls: [['get_order', { orderId: amanOrderId }]] }, { calls: [present('r1')] }]);
    const before = audit.events.length;
    const res = await chat(rahul, { text: `status of ${amanOrderId}?` });
    expect(res.json()).toMatchObject({ answer: NOT_FOUND.get_order, steps: [{ tool: 'get_order', status: 'not_found' }] });
    expect(res.body).not.toMatch(/Sample Road|Preparing|Delivered|Confirmed/);
    expect(audit.events.length).toBe(before + 1);
  });

  it('an invented id: not_found and no fabricated status', async () => {
    use([{ calls: [['get_order', { orderId: '99999999-9999-4999-8999-999999999999' }]] }, { calls: [present('r1')] }]);
    expect((await chat(rahul, { text: 'where is order 9999?' })).json().answer).toBe(NOT_FOUND.get_order);
  });

  it('customers only: owner and admin get 403, no token 401, extra fields 400', async () => {
    for (const email of ['owner@tadka.test', 'admin@tadka.test']) {
      expect((await chat((await stack.login(email)).accessToken, { text: 'hi' })).statusCode).toBe(403);
    }
    expect((await chat(undefined, { text: 'hi' })).statusCode).toBe(401);
    expect((await chat(rahul, { text: 'hi', userId: IDS.aman })).statusCode).toBe(400);
  });
});

describe('POST /assist/chat without AZURE_* settings', () => {
  it('is 503 assistant_not_configured', async () => {
    const plain = await startStack();
    const token = (await plain.login('rahul@tadka.test')).accessToken;
    const res = await plain.app.inject({ method: 'POST', url: '/assist/chat', payload: { text: 'hi' }, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'assistant_not_configured' });
  });
});
