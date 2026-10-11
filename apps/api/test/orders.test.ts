// M0 step 3: GET /orders returns only the caller's orders, and another customer's order
// is "not found" both over HTTP and at the service level.
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { OrdersService } from '../src/orders/service.js';
import { canTransition } from '../src/orders/state-machine.js';
import { NotFoundError } from '../src/shared/errors.js';
import { orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
let amanOrderId: string;
beforeAll(async () => {
  stack = await startStack();
  amanOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman)))[0]!.id;
});

const get = (url: string, token: string) => stack.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

describe('orders ownership', () => {
  it('Rahul sees only his own orders', async () => {
    const { accessToken } = await stack.login('rahul@tadka.test');
    const list = (await get('/orders', accessToken)).json() as { customerId: string }[];
    expect(list.length).toBe(5);
    expect(list.every((o) => o.customerId === IDS.rahul)).toBe(true);
  });

  it("Rahul asking for Aman's order by ID gets 404, not 403", async () => {
    const { accessToken } = await stack.login('rahul@tadka.test');
    expect((await get(`/orders/${amanOrderId}`, accessToken)).statusCode).toBe(404);
  });

  it("service level: OrdersService.get for Aman's order as Rahul throws NotFound", async () => {
    const svc = new OrdersService(stack.db, { chargeForOrder: async () => { throw new Error('not called'); } });
    await expect(svc.get({ userId: IDS.rahul, role: 'Customer' }, amanOrderId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a restaurant owner sees only their restaurant, without address or phone', async () => {
    const { accessToken } = await stack.login('owner@tadka.test');
    const list = (await get('/orders', accessToken)).json() as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((o) => o.restaurantId === IDS.spiceGarden)).toBe(true);
    expect(list.some((o) => 'deliveryAddress' in o || 'contactPhone' in o || 'customerId' in o)).toBe(false);
  });

  it('Admin sees every order', async () => {
    const { accessToken } = await stack.login('admin@tadka.test');
    expect(((await get('/orders', accessToken)).json() as unknown[]).length).toBe(9);
  });

  it('state machine rejects backwards and skipped moves', () => {
    expect(canTransition('Placed', 'Confirmed')).toBe(true);
    expect(canTransition('Delivered', 'Preparing')).toBe(false);
    expect(canTransition('Placed', 'Delivered')).toBe(false);
    expect(canTransition('Preparing', 'Cancelled')).toBe(false);
  });
});
