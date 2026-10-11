// EP2 step 1: the failure first. A tool that takes the user id from the model leaks other
// customers' data. Synthetic users and addresses only.
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { naiveGetOrder } from '../demo/naive-get-order.js';
import { orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
let amanOrderId: string;
beforeAll(async () => {
  stack = await startStack();
  amanOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman)))[0]!.id;
});

describe('the naive tool (deliberately vulnerable)', () => {
  it("lets Rahul's chat read Aman's address when the model supplies Aman's user id", async () => {
    // Rahul is logged in, but the tool never sees his token. It only sees what the model wrote.
    const argsFromModel = { userId: IDS.aman, orderId: amanOrderId };
    const r = await naiveGetOrder(stack.db, argsFromModel);
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.order.deliveryAddress).toBe('House 7, Sample Road, Mumbai 400001');
  });
});

describe('the real tool (the fix)', () => {
  it("returns not_found for Aman's order in Rahul's chat, with no trace of the order", async () => {
    const { executeToolCall } = await import('../src/assist/tools/executor.js');
    const { memoryAudit } = await import('../src/assist/tools/audit.js');
    const { OrdersService } = await import('../src/orders/service.js');
    const { RestaurantsService } = await import('../src/restaurants/service.js');
    const deps = { orders: new OrdersService(stack.db, {} as never), restaurants: new RestaurantsService(stack.db), audit: memoryAudit(), log: () => {} };
    // Even if the model adds Aman's user id, the strict schema refuses it...
    const withUserId = await executeToolCall(deps, { userId: IDS.rahul, role: 'Customer' }, { callId: 'c1', tool: 'get_order', input: { userId: IDS.aman, orderId: amanOrderId } });
    expect(withUserId.publicStatus).toBe('invalid_args');
    // ...and without it, the identity comes from Rahul's token, so the service says not found.
    const r = await executeToolCall(deps, { userId: IDS.rahul, role: 'Customer' }, { callId: 'c2', tool: 'get_order', input: { orderId: amanOrderId } });
    expect(r.modelResult).toEqual({ status: 'not_found' });
    expect(JSON.stringify(r)).not.toContain('Sample Road');
  });
});
