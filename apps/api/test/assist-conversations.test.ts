// EP3: conversations and memories end to end, with the real database and a scripted model.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LOOP } from '../src/assist/agent-loop.js';
import { BudgetLedger } from '../src/assist/budget.js';
import { pairProblem } from '../src/assist/history.js';
import { CLARIFY } from '../src/assist/templates.js';
import { memoryAudit } from '../src/assist/tools/audit.js';
import { buildApp, type AssistantDeps } from '../src/app.js';
import { HttpPaymentProvider } from '../src/payments/provider.js';
import { RestaurantsService } from '../src/restaurants/service.js';
import { conversations as convTable, menuItems, messages, orders, turns } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { present, scripted, type Step } from './fake-model.js';
import { startStack } from './helpers.js';

const model = scripted([]);
const prompts: unknown[] = [];
const use = (steps: Step[]) => { const inner = scripted(steps); model.doGenerate = (opts) => { prompts.push(opts.prompt); return inner.doGenerate(opts); }; };
const assistant: AssistantDeps = {
  model, providerOptions: {}, audit: memoryAudit(),
  ledger: new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'conv-')), 'usage.json'), 5),
  config: { ...DEFAULT_LOOP, priceKey: 'azure:gpt-5.4-mini', maxOutputTokens: 400, turnBudgetUsd: 0.05, estimateMargin: 1.25 },
};
const clarify = (reason: keyof typeof CLARIFY): [string, unknown] => ['final_answer', { kind: 'clarify', resultIds: [], clarifyReason: reason }];
const lastPrompt = () => JSON.stringify(prompts.at(-1));

let stack: Awaited<ReturnType<typeof startStack>>;
let rahul: string;
let aman: string;
let rahulRestaurant: string;
beforeAll(async () => {
  stack = await startStack({ assistant });
  rahul = (await stack.login('rahul@tadka.test')).accessToken;
  aman = (await stack.login('aman@tadka.test')).accessToken;
  rahulRestaurant = (await stack.db.select().from(orders).where(eq(orders.id, IDS.rahulPlacedOrder)))[0]!.restaurantId;
});

type Req = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: object };
const as = (token: string, r: Req, app = stack.app) => app.inject({ ...r, headers: { authorization: `Bearer ${token}` } });
const newConversation = async (token = rahul) => (await as(token, { method: 'POST', url: '/assist/conversations' })).json().conversationId as string;
const say = (id: string, text: string, token = rahul, app = stack.app) => as(token, { method: 'POST', url: `/assist/conversations/${id}/messages`, payload: { text } }, app);

describe('a conversation remembers earlier turns', () => {
  it('the follow-up sees turn 1, and the history shows what the customer saw', async () => {
    const id = await newConversation();
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('t1r1')] }]);
    const t1 = await say(id, 'what is my latest order?');
    expect(t1.statusCode).toBe(200);
    expect(t1.json()).toMatchObject({ stopReason: 'answered', context: { turnsSent: 0, turnsDropped: 0, historyBytes: 0 } });

    use([{ calls: [['get_restaurant_menu', { restaurantId: rahulRestaurant }]] }, { calls: [present('t2r1')] }]);
    const t2 = await say(id, 'and what is on the menu there?');
    expect(t2.json()).toMatchObject({ stopReason: 'answered', context: { turnsSent: 1, turnsDropped: 0 } });
    expect(t2.json().answer).toMatch(/menu:/);
    expect(lastPrompt()).toContain('what is my latest order?');

    const h = (await as(rahul, { method: 'GET', url: `/assist/conversations/${id}` })).json();
    expect(JSON.stringify(h)).toContain('and what is on the menu there?');
    expect(JSON.stringify(h)).not.toMatch(/toolCallId|tool-result/); // never tool internals
  });

  it('survives a restart: a new app on the same database continues the conversation', async () => {
    const id = await newConversation();
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('t1r1')] }]);
    await say(id, 'what is my latest order?');

    const restarted = buildApp({ db: stack.db, keys: stack.keys, provider: new HttpPaymentProvider('http://127.0.0.1:9', 150), assistant });
    try {
      use([{ calls: [clarify('which_restaurant')] }]);
      const res = await say(id, 'and the menu there?', rahul, restarted);
      expect(res.json()).toMatchObject({ context: { turnsSent: 1 } });
      expect(lastPrompt()).toContain('what is my latest order?');
    } finally { await restarted.close(); }
  });

  it('POST /assist/chat stays single turn: the follow-up has no history', async () => {
    use([{ calls: [['get_my_orders', {}]] }, { calls: [present('r1')] }]);
    await as(rahul, { method: 'POST', url: '/assist/chat', payload: { text: 'what is my latest order?' } });
    use([{ calls: [clarify('which_restaurant')] }]);
    const r = await as(rahul, { method: 'POST', url: '/assist/chat', payload: { text: 'and what is on the menu there?' } });
    expect(r.json()).toMatchObject({ stopReason: 'clarify', answer: CLARIFY.which_restaurant });
    expect(lastPrompt()).not.toContain('what is my latest order?');
  });

  it('a small history budget drops whole old turns and says which ids were discussed', async () => {
    const small = buildApp({ db: stack.db, keys: stack.keys, provider: new HttpPaymentProvider('http://127.0.0.1:9', 150), assistant: { ...assistant, historyBudgetBytes: 1500 } });
    try {
      const id = await newConversation();
      for (const [i, q] of ['latest order?', 'latest order again?', 'and once more?'].entries()) {
        use([{ calls: [['get_my_orders', {}]] }, { calls: [present(`t${i + 1}r1`)] }]);
        expect((await say(id, q, rahul, small)).json().stopReason).toBe('answered');
      }
      use([{ calls: [clarify('which_order')] }]);
      const r = (await say(id, 'which one?', rahul, small)).json();
      expect(r.context.turnsDropped).toBeGreaterThan(0);
      expect(r.context.historyBytes).toBeLessThanOrEqual(1500);
      expect(lastPrompt()).toContain('[Note from the application, not the customer]');
      expect(lastPrompt()).not.toContain('"latest order?"'); // the oldest turn is gone, whole
    } finally { await small.close(); }
  });
});

describe('ownership and concurrency', () => {
  it("Aman can't read, write to or delete Rahul's conversation: 404, same as an invented id", async () => {
    const id = await newConversation();
    const invented = '99999999-9999-4999-8999-999999999999';
    for (const target of [id, invented]) {
      expect((await as(aman, { method: 'GET', url: `/assist/conversations/${target}` })).statusCode).toBe(404);
      expect((await say(target, 'hi', aman)).statusCode).toBe(404);
      expect((await as(aman, { method: 'DELETE', url: `/assist/conversations/${target}` })).statusCode).toBe(404);
    }
    const list = (await as(aman, { method: 'GET', url: '/assist/conversations' })).json();
    expect(JSON.stringify(list)).not.toContain(id);
  });

  it('two messages at once: one is stored, the other is 409 conversation_busy', async () => {
    const id = await newConversation();
    use([{ calls: [clarify('which_order')], delayMs: 150 }]);
    const [a, b] = await Promise.all([say(id, 'first tab'), say(id, 'second tab')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json()).toEqual({ error: 'conversation_busy' });
    const stored = await stack.db.select().from(turns).where(eq(turns.conversationId, id));
    expect(stored).toHaveLength(1);
    const winner = [a, b].find((r) => r.statusCode === 200)!;
    expect(stored[0]!.answer).toBe(winner.json().answer);
    expect((await stack.db.select().from(convTable).where(eq(convTable.id, id)))[0]).toMatchObject({ version: 1, turnCount: 1 });
    const msgs = await stack.db.select().from(messages).where(eq(messages.conversationId, id));
    expect(new Set(msgs.map((m) => m.turnNo))).toEqual(new Set([1])); // only the winner's messages
    expect(pairProblem(msgs.sort((x, y) => x.seq - y.seq).map((m) => m.content) as never)).toBeNull();
    use([{ calls: [clarify('which_order')] }]);
    expect((await say(id, 'next')).statusCode).toBe(200); // the conversation carries on from the winner
  });

  it('delete removes turns and messages, and nothing of anyone else', async () => {
    const mine = await newConversation();
    const his = await newConversation(aman);
    use([{ calls: [clarify('which_order')] }]);
    await say(mine, 'hi');
    await say(his, 'hi', aman);
    expect((await as(rahul, { method: 'DELETE', url: `/assist/conversations/${mine}` })).statusCode).toBe(204);
    expect(await stack.db.select().from(messages).where(eq(messages.conversationId, mine))).toHaveLength(0);
    expect(await stack.db.select().from(turns).where(eq(turns.conversationId, mine))).toHaveLength(0);
    expect(await stack.db.select().from(convTable).where(eq(convTable.id, his))).toHaveLength(1);
    expect((await as(rahul, { method: 'GET', url: `/assist/conversations/${mine}` })).statusCode).toBe(404);
  });

  it('customers only: owner and admin get 403', async () => {
    for (const email of ['owner@tadka.test', 'admin@tadka.test']) {
      const t = (await stack.login(email)).accessToken;
      expect((await as(t, { method: 'POST', url: '/assist/conversations' })).statusCode).toBe(403);
      expect((await as(t, { method: 'GET', url: '/assist/memories' })).statusCode).toBe(403);
    }
  });
});

describe('memory the customer chose', () => {
  it('only the allow-list can be saved', async () => {
    expect((await as(rahul, { method: 'PUT', url: '/assist/memories/diet', payload: { value: 'vegan' } })).statusCode).toBe(400);
    expect((await as(rahul, { method: 'PUT', url: '/assist/memories/address', payload: { value: 'vegetarian' } })).statusCode).toBe(400);
    expect((await as(rahul, { method: 'PUT', url: '/assist/memories/diet', payload: { value: 'vegetarian', note: 'x' } })).statusCode).toBe(400);
  });

  it('vegetarian is applied by the app to menus, is private to the customer, and can be deleted', async () => {
    const saved = await as(rahul, { method: 'PUT', url: '/assist/memories/diet', payload: { value: 'vegetarian' } });
    expect(saved.json()).toEqual({ diet: 'vegetarian' });
    expect((await as(aman, { method: 'GET', url: '/assist/memories' })).json()).toEqual({});

    const id = await newConversation();
    use([{ calls: [['get_restaurant_menu', { restaurantId: IDS.biryaniHouse }]] }, { calls: [present('t1r1')] }]);
    const r = (await say(id, 'menu of Biryani House?')).json();
    expect(r.answer).toContain('Vegetarian items only, as you asked us to remember.');
    expect(r.answer).not.toContain('Chicken Biryani');

    expect((await as(rahul, { method: 'DELETE', url: '/assist/memories/diet' })).statusCode).toBe(204);
    expect((await as(rahul, { method: 'DELETE', url: '/assist/memories/diet' })).statusCode).toBe(404);
    use([{ calls: [['get_restaurant_menu', { restaurantId: IDS.biryaniHouse }]] }, { calls: [present('t2r1')] }]);
    const after = (await say(id, 'and now?')).json().answer;
    expect(after).toContain('Chicken Biryani');
    expect(after).not.toContain('Vegetarian items only');
  });

  it('the filter is a database query on the seeded flags, for every restaurant', async () => {
    const svc = new RestaurantsService(stack.db);
    const all = await stack.db.select().from(menuItems);
    expect(all.filter((i) => !i.isVeg).map((i) => i.name)).toEqual(['Chicken Biryani']); // the seed sets every item explicitly
    for (const r of [IDS.spiceGarden, IDS.chaiPoint, IDS.biryaniHouse]) {
      const veg = await svc.menuPage(r, 25, { vegOnly: true });
      const full = await svc.menuPage(r, 25);
      expect(veg.items.every((i) => i.isVeg)).toBe(true);
      expect(veg.items.map((i) => i.id)).toEqual(full.items.filter((i) => i.isVeg).map((i) => i.id));
      expect(full.items).toHaveLength(all.filter((i) => i.restaurantId === r).length);
    }
  });
});

describe('logs', () => {
  it("never contain the customer's text, the answer or order details, on success or failure", async () => {
    const lines: string[] = [];
    const logged = buildApp({ db: stack.db, keys: stack.keys, provider: new HttpPaymentProvider('http://127.0.0.1:9', 150), assistant, logStream: { write: (l) => { lines.push(l); } } });
    const MARK = 'ZEBRA-7731';
    try {
      const id = await newConversation();
      use([{ calls: [['get_my_orders', {}]] }, { calls: [present('t1r1')] }]);
      const ok = (await say(id, `${MARK} where is my order?`, rahul, logged)).json();
      use([{ throws: new Error(`provider failed for input ${MARK}`) }]);
      expect((await say(id, `${MARK} again`, rahul, logged)).json().stopReason).toBe('provider_error');
      expect((await say(id, `${MARK} ${'x'.repeat(600)}`, rahul, logged)).statusCode).toBe(400);
      await as(rahul, { method: 'PUT', url: '/assist/memories/diet', payload: { value: MARK } }, logged);

      const all = lines.join('');
      expect(all).toContain('"event":"assist.turn"'); // the logger is on and the turns were logged
      expect(all).not.toContain(MARK);
      expect(all).not.toContain(ok.answer.split('\n')[1] ?? ok.answer);
      expect(all).not.toMatch(/Test Lane|Sample Road|totalPaise/);
    } finally { await logged.close(); }
  });
});

describe('without a configured provider', () => {
  it('conversations can be listed, but a message is 503 assistant_not_configured', async () => {
    const plain = await startStack();
    const t = (await plain.login('rahul@tadka.test')).accessToken;
    const id = (await as(t, { method: 'POST', url: '/assist/conversations' }, plain.app)).json().conversationId;
    const res = await say(id, 'hi', t, plain.app);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'assistant_not_configured' });
  });
});
