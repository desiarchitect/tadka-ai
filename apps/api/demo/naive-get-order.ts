// DELIBERATELY VULNERABLE FIXTURE. Do not copy. Never imported by src/.
//
// This is the tool most first attempts at "let the model call our API" look like: the model
// fills in { userId, orderId }, and the tool trusts both and reads the database directly.
// Whoever controls the model's arguments (a confused model, or a user who asks it nicely)
// controls whose data comes back. The EP2 test shows Rahul reading Aman's delivery address
// through it. The real tools in src/assist/tools/ take the identity from the verified token
// and go through the orders service instead.
import { and, eq } from 'drizzle-orm';
import type { Db } from '../src/shared/db.js';
import { orders } from '../src/shared/schema.js';

export type NaiveGetOrderArgs = { userId: string; orderId: string };

export async function naiveGetOrder(db: Db, args: NaiveGetOrderArgs) {
  const [o] = await db.select().from(orders).where(and(eq(orders.id, args.orderId), eq(orders.customerId, args.userId)));
  if (!o) return { status: 'not_found' as const };
  return { status: 'ok' as const, order: { id: o.id, status: o.status, deliveryAddress: o.deliveryAddress, contactPhone: o.contactPhone } };
}
