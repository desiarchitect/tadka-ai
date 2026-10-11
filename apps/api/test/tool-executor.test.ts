// EP2 step 2: the executor contract. Real services and database, no model.
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoryAudit } from '../src/assist/tools/audit.js';
import { executeToolCall, type ExecutorDeps, type ToolCallRequest } from '../src/assist/tools/executor.js';
import { fitResult, type ToolData } from '../src/assist/tools/views.js';
import { OrdersService } from '../src/orders/service.js';
import { RestaurantsService } from '../src/restaurants/service.js';
import type { Principal } from '../src/shared/principal.js';
import { orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
let amanOrderId: string;
let rahulOrderId: string;
const rahul: Principal = { userId: IDS.rahul, role: 'Customer' };
const INVENTED = '99999999-9999-4999-8999-999999999999';

function deps(over: Partial<ExecutorDeps> = {}) {
  const audit = memoryAudit();
  const logs: unknown[] = [];
  const d: ExecutorDeps = {
    orders: new OrdersService(stack.db, {} as never),
    restaurants: new RestaurantsService(stack.db),
    audit, log: (l) => logs.push(l), ...over,
  };
  return { d, audit: over.audit ? undefined : audit, logs };
}
const call = (tool: string, input: unknown, extra: Partial<ToolCallRequest> = {}): ToolCallRequest => ({ callId: 'c1', tool, input, ...extra });

beforeAll(async () => {
  stack = await startStack();
  amanOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman)))[0]!.id;
  rahulOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.rahul)))[0]!.id;
});

describe('executor: the happy paths return allow-listed fields only', () => {
  it("get_my_orders: the caller's orders, no address or phone", async () => {
    const r = await executeToolCall(deps().d, rahul, call('get_my_orders', {}));
    expect(r.status).toBe('ok');
    const text = JSON.stringify(r.modelResult);
    expect(text).not.toMatch(/deliveryAddress|contactPhone|customerId|Test Lane|Sample Road/);
    expect(r.modelResult.status === 'ok' && r.modelResult.data.kind === 'orders' && r.modelResult.data.orders.length).toBeGreaterThan(0);
  });

  it('get_order: own order', async () => {
    const r = await executeToolCall(deps().d, rahul, call('get_order', { orderId: rahulOrderId }));
    expect(r.modelResult).toMatchObject({ status: 'ok', data: { kind: 'order', order: { orderId: rahulOrderId } } });
    expect(Object.keys((r.modelResult as { data: { order: object } }).data.order).sort()).toEqual(['orderId', 'placedAt', 'restaurantId', 'status', 'totalPaise']);
  });

  it('get_restaurant_menu: item id, name and price, labelled as data', async () => {
    const r = await executeToolCall(deps().d, rahul, call('get_restaurant_menu', { restaurantId: IDS.spiceGarden }));
    expect(r.status).toBe('ok');
    const data = (r.modelResult as { data: Extract<ToolData, { kind: 'menu' }> }).data;
    expect(Object.keys(data.items[0]!).sort()).toEqual(['itemId', 'name', 'pricePaise']);
    expect(data.dataLabel).toMatch(/untrusted_data/);
  });
});

describe('executor: refusals, each with exactly one result and no side effect', () => {
  it('unknown tool, unparsable input, an extra userId field and a bad id are invalid_args', async () => {
    const before = await stack.db.select().from(orders);
    const { d } = deps();
    expect((await executeToolCall(d, rahul, call('delete_order', {}))).modelResult).toEqual({ status: 'invalid_args', reason: 'unknown_tool' });
    expect((await executeToolCall(d, rahul, call('get_order', 'not json', { unparsable: true }))).modelResult).toEqual({ status: 'invalid_args', reason: 'unparsable' });
    const extra = await executeToolCall(d, rahul, call('get_order', { orderId: amanOrderId, userId: IDS.aman }));
    expect(extra.status).toBe('invalid_args');
    expect(JSON.stringify(extra.modelResult)).toContain('unrecognized_keys');
    expect((await executeToolCall(d, rahul, call('get_order', { orderId: 'abc' }))).status).toBe('invalid_args');
    expect(await stack.db.select().from(orders)).toEqual(before);
  });

  it('a tool not offered to the role looks exactly like an unknown tool', async () => {
    const owner: Principal = { userId: IDS.owner, role: 'RestaurantOwner', restaurantId: IDS.spiceGarden };
    const r = await executeToolCall(deps().d, owner, call('get_my_orders', {}));
    expect(r.modelResult).toEqual({ status: 'invalid_args', reason: 'unknown_tool' });
  });

  it('a backend failure is failed, never an empty list', async () => {
    const broken = { listRecent: async () => { throw new Error('connection refused'); } } as never;
    const r = await executeToolCall(deps({ orders: broken }).d, rahul, call('get_my_orders', {}));
    expect(r.modelResult).toEqual({ status: 'failed' });
  });
});

describe("someone else's order (section 3a)", () => {
  it('the model sees not_found, identical to an invented id', async () => {
    const a = await executeToolCall(deps().d, rahul, call('get_order', { orderId: amanOrderId }));
    const b = await executeToolCall(deps().d, rahul, call('get_order', { orderId: INVENTED }));
    expect(a.modelResult).toEqual({ status: 'not_found' });
    expect(b.modelResult).toEqual(a.modelResult);
    expect(a.publicStatus).toBe(b.publicStatus);
    expect(a.status).toBe('forbidden_as_not_found'); // internal only
    expect(b.status).toBe('not_found');
  });

  it('ordinary logs are identical; only the audit channel records the denial, without the raw id', async () => {
    const foreign = deps();
    const invented = deps();
    await executeToolCall(foreign.d, rahul, call('get_order', { orderId: amanOrderId }));
    await executeToolCall(invented.d, rahul, call('get_order', { orderId: INVENTED }));
    expect(foreign.logs).toEqual(invented.logs);
    expect(invented.audit!.events).toEqual([]);
    expect(foreign.audit!.events).toHaveLength(1);
    expect(foreign.audit!.events[0]).toMatchObject({ event: 'forbidden_as_not_found', tool: 'get_order', principalId: IDS.rahul });
    expect(JSON.stringify(foreign.audit!.events)).not.toContain(amanOrderId);
  });
});

describe('result size cap (section 3i)', () => {
  const order = { orderId: 'o', restaurantId: 'r', status: 'Placed', totalPaise: 1, placedAt: 'x' };
  it('drops whole trailing list items and marks the result truncated', () => {
    const data: ToolData = { kind: 'orders', orders: Array.from({ length: 10 }, () => order), hasMore: false };
    const fitted = fitResult(data, 400)!;
    expect(fitted.kind === 'orders' && fitted.orders.length).toBeLessThan(10);
    expect(fitted.kind === 'orders' && fitted.hasMore).toBe(true);
    expect(JSON.parse(JSON.stringify(fitted))).toEqual(fitted);
  });

  it('a single object over the cap is failed / result_too_large', async () => {
    const r = await executeToolCall(deps({ maxResultBytes: 50 }).d, rahul, call('get_order', { orderId: rahulOrderId }));
    expect(r.modelResult).toEqual({ status: 'failed' });
    expect(r.reason).toBe('result_too_large');
  });
});
