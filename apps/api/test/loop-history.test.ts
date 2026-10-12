// EP3: the loop with conversation history. Fake model, in-memory services.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOP, runTurn, type LoopDeps } from '../src/assist/agent-loop.js';
import { BudgetLedger } from '../src/assist/budget.js';
import { pairProblem } from '../src/assist/history.js';
import { memoryAudit } from '../src/assist/tools/audit.js';
import type { ToolServices as ExecutorServices } from '../src/assist/tools/registry.js';
import type { Principal } from '../src/shared/principal.js';
import { present, scripted, type Step } from './fake-model.js';

const rahul: Principal = { userId: '11111111-1111-4111-8111-111111111111', role: 'Customer' };
const REST = 'aaaaaaaa-0000-4000-8000-000000000003';
const order = { id: '0000000a-0000-4000-8000-000000000000', restaurantId: REST, status: 'Preparing', totalPaise: 59800, createdAt: new Date('2026-10-01T12:00:00Z') };
const menuCalls: { vegOnly?: boolean }[] = [];
const items = [{ id: 'i1', name: 'Chicken Biryani', pricePaise: 34900, isVeg: false }, { id: 'i2', name: 'Veg Biryani', pricePaise: 24900, isVeg: true }];
const services = {
  orders: { listRecent: async () => ({ orders: [order], hasMore: false }), get: async () => order },
  restaurants: {
    menuPage: async (_id: string, _limit: number, opts: { vegOnly?: boolean } = {}) => {
      menuCalls.push(opts);
      const list = opts.vegOnly ? items.filter((i) => i.isVeg) : items;
      return { restaurant: { id: REST, name: 'Biryani House', city: 'Hyderabad' }, items: list, totalItems: list.length };
    },
  },
};

function deps(steps: Step[], prefs?: { diet?: 'vegetarian' }) {
  const model = scripted(steps);
  const d: LoopDeps = {
    model, providerOptions: {},
    executor: { ...(services as object as ExecutorServices), prefs, audit: memoryAudit(), log: () => {} },
    ledger: new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'hist-')), 'u.json'), 5),
    config: { ...DEFAULT_LOOP, priceKey: 'azure:gpt-5.4-mini', maxOutputTokens: 400, turnBudgetUsd: 0.05, estimateMargin: 1.25 },
    log: () => {},
  };
  return { d, model };
}

describe('a follow-up turn', () => {
  it('sends the earlier turn, numbers results per turn, and stores a complete turn', async () => {
    const first = deps([{ calls: [['get_my_orders', {}]] }, { calls: [present('t1r1')] }]);
    const t1 = await runTurn(first.d, rahul, 'what is my latest order?', { turnNo: 1 });
    expect(t1.stopReason).toBe('answered');
    expect(pairProblem(t1.turnMessages)).toBeNull();
    expect(t1.turnMessages.at(-1)).toMatchObject({ role: 'tool', content: [{ toolName: 'final_answer', output: { value: { status: 'shown' } } }] });

    const second = deps([{ calls: [['get_restaurant_menu', { restaurantId: REST }]] }, { calls: [present('t2r1')] }]);
    const t2 = await runTurn(second.d, rahul, 'and what is on the menu there?', { turnNo: 2, history: t1.turnMessages });
    expect(t2.answer).toContain('Biryani House (Hyderabad) menu:');
    const prompt = JSON.stringify(second.model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain('what is my latest order?'); // the model saw turn 1
    expect(t2.turnMessages[0]).toEqual({ role: 'user', content: 'and what is on the menu there?' }); // only this turn is returned for storage
  });

  it("an earlier turn's result can't be presented as current", async () => {
    const first = deps([{ calls: [['get_my_orders', {}]] }, { calls: [present('t1r1')] }]);
    const t1 = await runTurn(first.d, rahul, 'latest order?', { turnNo: 1 });
    const second = deps([{ calls: [present('t1r1')] }]);
    expect((await runTurn(second.d, rahul, 'status again?', { turnNo: 2, history: t1.turnMessages })).stopReason).toBe('invalid_output');
  });

  it('a broken history is never sent', async () => {
    const broken: ModelMessage[] = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'gone', toolName: 'get_order', output: { type: 'json', value: {} } }] }];
    const t = deps([{ calls: [present('t2r1')] }]);
    const r = await runTurn(t.d, rahul, 'hi', { turnNo: 2, history: broken });
    expect(r.stopReason).toBe('invalid_history');
    expect(t.model.doGenerateCalls).toHaveLength(0);
  });

  it('a turn that stops early still returns only complete pairs', async () => {
    const t = deps([{ calls: [['get_my_orders', {}]] }, { text: 'prose' }, { text: 'prose' }]);
    const r = await runTurn(t.d, rahul, 'hi', { turnNo: 1 });
    expect(r.stopReason).toBe('invalid_output');
    expect(pairProblem(r.turnMessages)).toBeNull();
  });
});

describe('the vegetarian preference is applied by the application', () => {
  it('with the preference: vegetarian items only, and the answer says so', async () => {
    menuCalls.length = 0;
    const t = deps([{ calls: [['get_restaurant_menu', { restaurantId: REST }]] }, { calls: [present('r1')] }], { diet: 'vegetarian' });
    const r = await runTurn(t.d, rahul, 'menu?');
    expect(menuCalls).toEqual([{ vegOnly: true }]);
    expect(r.answer).toContain('- Veg Biryani: Rs 249.00');
    expect(r.answer).not.toContain('Chicken');
    expect(r.answer).toContain('Vegetarian items only, as you asked us to remember.');
  });

  it('without it: the whole menu', async () => {
    const t = deps([{ calls: [['get_restaurant_menu', { restaurantId: REST }]] }, { calls: [present('r1')] }]);
    expect((await runTurn(t.d, rahul, 'menu?')).answer).toContain('Chicken Biryani');
  });
});
