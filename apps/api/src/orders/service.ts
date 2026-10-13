// Orders. Ownership is enforced here, for every caller: a customer sees only their own
// orders, an owner sees only their restaurant's orders (without the delivery address or
// phone), an Admin sees all. An order the caller may not see is reported as not found,
// so its existence doesn't leak.
import { and, desc, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../shared/db.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import { orderItems, orders, type OrderStatus } from '../shared/schema.js';
import { inSpan } from '../shared/tracing.js';
import type { PaymentsPublic } from '../payments/service.js';
import { canTransition } from './state-machine.js';

type OrderRow = typeof orders.$inferSelect;

export class OrdersService {
  constructor(private readonly db: Db, private readonly payments: PaymentsPublic) {}

  list(p: Principal) {
    return inSpan('orders.list', { 'tadka.role': p.role }, async () => {
      const rows = await this.db.select().from(orders).where(scopeFor(p)).orderBy(desc(orders.createdAt));
      return rows.map((o) => view(p, o));
    });
  }

  // Orders that are still in progress (not Delivered, not Cancelled), newest first.
  listActive(p: Principal) {
    return inSpan('orders.listActive', { 'tadka.role': p.role }, async () => {
      const rows = await this.db.select().from(orders)
        .where(and(scopeFor(p), notInArray(orders.status, ['Delivered', 'Cancelled'])))
        .orderBy(desc(orders.createdAt));
      return rows.map((o) => view(p, o));
    });
  }

  // The caller's most recent orders for the assistant: newest first, then by id so equal
  // timestamps always come back in the same order. At most `limit`, with `hasMore` when older
  // orders exist. "Latest order" means the first row of this ordering.
  listRecent(p: Principal, limit: number) {
    return inSpan('orders.listRecent', { 'tadka.role': p.role }, async () => {
      const rows = await this.db.select().from(orders).where(scopeFor(p))
        .orderBy(desc(orders.createdAt), desc(orders.id)).limit(limit + 1);
      return { orders: rows.slice(0, limit).map((o) => view(p, o)), hasMore: rows.length > limit };
    });
  }

  get(p: Principal, orderId: string) {
    // The order id goes on the span only after the order was found for this caller: a foreign or invented id is never recorded.
    return inSpan('orders.get', {}, async (span) => {
      const o = await this.findVisible(p, orderId);
      span.setAttribute('tadka.order_id', o.id);
      const items = await this.db.select().from(orderItems).where(eq(orderItems.orderId, o.id));
      return { ...view(p, o), items };
    });
  }

  // Charge a Placed order and confirm it. Safe to repeat: the payment uses a stable
  // provider key per order, and an already-confirmed order just reports its state.
  pay(p: Principal, orderId: string) {
    return inSpan('orders.pay', {}, async (span) => {
      const o = await this.findVisible(p, orderId);
      span.setAttribute('tadka.order_id', o.id);
      if (o.status !== 'Placed') {
        if (o.status === 'Confirmed') return view(p, o);
        throw new ConflictError(`order_is_${o.status}`);
      }
      await this.payments.chargeForOrder(p, { orderId: o.id, customerId: o.customerId, amountPaise: o.totalPaise });
      return view(p, await this.transition(o, 'Confirmed'));
    });
  }

  // One statement: the order if this caller may see it, plus whether an order with this id
  // exists at all. A single statement reads one snapshot, so the denial classification can't
  // race the read. The existence part returns a boolean only, never a row of someone else's.
  // The caller always gets the same NotFoundError; `denied` is for internal diagnosis.
  private async findVisible(p: Principal, orderId: string): Promise<OrderRow> {
    const [r] = await this.db
      .select({ exists: sql<boolean>`exists (select 1 from ${orders} where ${orders.id} = ${orderId})`, order: orders })
      .from(sql`(select 1) as one`)
      .leftJoin(orders, and(eq(orders.id, orderId), scopeFor(p)));
    if (!r?.order) throw new NotFoundError('order_not_found', { denied: r?.exists === true });
    return r.order;
  }

  // Optimistic concurrency: the update only applies if nobody changed the row since we read it.
  private async transition(o: OrderRow, to: OrderStatus): Promise<OrderRow> {
    if (!canTransition(o.status, to)) throw new ConflictError(`cannot_move_${o.status}_to_${to}`);
    const [updated] = await this.db.update(orders)
      .set({ status: to, version: o.version + 1, updatedAt: new Date() })
      .where(and(eq(orders.id, o.id), eq(orders.version, o.version)))
      .returning();
    if (!updated) throw new ConflictError('order_changed_concurrently');
    return updated;
  }
}

function scopeFor(p: Principal): SQL | undefined {
  if (p.role === 'Admin') return undefined;
  if (p.role === 'RestaurantOwner') return eq(orders.restaurantId, p.restaurantId ?? '00000000-0000-0000-0000-000000000000');
  return eq(orders.customerId, p.userId);
}

// Owners don't get the customer's address or phone.
function view(p: Principal, o: OrderRow) {
  const base = { id: o.id, restaurantId: o.restaurantId, status: o.status, totalPaise: o.totalPaise, version: o.version, createdAt: o.createdAt };
  if (p.role === 'RestaurantOwner') return base;
  return { ...base, customerId: o.customerId, deliveryAddress: o.deliveryAddress, contactPhone: o.contactPhone };
}
