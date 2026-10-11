// EP2 step 2 (service side): the bounded, deterministic reads the tools use, and the internal
// denial classification. Ownership stays in the services.
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { OrdersService } from '../src/orders/service.js';
import { RestaurantsService } from '../src/restaurants/service.js';
import { NotFoundError } from '../src/shared/errors.js';
import type { Principal } from '../src/shared/principal.js';
import { menuItems, orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
let svc: OrdersService;
let amanOrderId: string;
const rahul: Principal = { userId: IDS.rahul, role: 'Customer' };
const INVENTED = '99999999-9999-4999-8999-999999999999';
beforeAll(async () => {
  stack = await startStack();
  svc = new OrdersService(stack.db, { chargeForOrder: async () => { throw new Error('not used'); } } as never);
  amanOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman)))[0]!.id;
});

const notFound = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { return e as NotFoundError; }
  throw new Error('expected NotFoundError');
};

describe('orders.listRecent', () => {
  it('is newest first, breaks equal timestamps by id, caps the list and reports hasMore', async () => {
    const at = new Date(Date.UTC(2026, 9, 5, 9, 0));
    const ids = ['cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002'];
    for (const id of ids) {
      await stack.db.insert(orders).values({ id, customerId: IDS.rahul, restaurantId: IDS.chaiPoint, status: 'Placed', totalPaise: 3900, deliveryAddress: 'x', contactPhone: 'y', createdAt: at });
    }
    const r = await svc.listRecent(rahul, 3);
    expect(r.orders.map((o) => o.id).slice(0, 2)).toEqual([ids[1], ids[0]]);
    expect(r.orders).toHaveLength(3);
    expect(r.hasMore).toBe(true);
    expect(r.orders.every((o) => 'customerId' in o && o.customerId === IDS.rahul)).toBe(true);
    const all = await svc.listRecent(rahul, 50);
    expect(all.hasMore).toBe(false);
    expect((await svc.listRecent(rahul, 3)).orders.map((o) => o.id)).toEqual(r.orders.map((o) => o.id)); // stable
  });
});

describe('denial classification (internal only)', () => {
  it("marks someone else's order as denied and an invented id as not denied, with the same message", async () => {
    const foreign = await notFound(() => svc.get(rahul, amanOrderId));
    const invented = await notFound(() => svc.get(rahul, INVENTED));
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(foreign.denied).toBe(true);
    expect(invented.denied).toBe(false);
    expect(foreign.message).toBe(invented.message);
  });

  it('the flag is not serialized and is never inferred from the message', () => {
    expect(JSON.stringify(new NotFoundError('order_not_found', { denied: true }))).not.toContain('denied');
    expect(Object.keys(new NotFoundError('x', { denied: true }))).not.toContain('denied');
    expect(new NotFoundError('denied: order belongs to someone else').denied).toBe(false);
  });

  it('the HTTP 404 is byte-identical for a foreign and an invented id', async () => {
    const { accessToken } = await stack.login('rahul@tadka.test');
    const get = (id: string) => stack.app.inject({ method: 'GET', url: `/orders/${id}`, headers: { authorization: `Bearer ${accessToken}` } });
    const [a, b] = [await get(amanOrderId), await get(INVENTED)];
    expect(a.statusCode).toBe(404);
    expect(a.body).toBe(b.body);
    const drop = (h: Record<string, unknown>) => { const { date, ...rest } = h; return rest; };
    expect(drop(a.headers)).toEqual(drop(b.headers));
  });
});

describe('restaurants.menuPage', () => {
  it('returns at most the limit in a fixed order, with the total', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ restaurantId: IDS.chaiPoint, name: `Item ${String(i).padStart(2, '0')}`, pricePaise: 1000 + i }));
    await stack.db.insert(menuItems).values(rows);
    const svcR = new RestaurantsService(stack.db);
    const page = await svcR.menuPage(IDS.chaiPoint, 25);
    expect(page.items).toHaveLength(25);
    expect(page.totalItems).toBe(62);
    const names = page.items.map((i) => i.name);
    expect(names).toEqual([...names].sort());
    expect((await svcR.menuPage(IDS.chaiPoint, 25)).items.map((i) => i.id)).toEqual(page.items.map((i) => i.id));
  });
});
