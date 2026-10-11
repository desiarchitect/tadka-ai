// Synthetic seed data (no real people, addresses or numbers). Used by `pnpm db:seed`
// and by the integration tests, so both see the same world.
import { sql } from 'drizzle-orm';
import { hashPassword } from '../identity/passwords.js';
import type { Db } from './db.js';
import { menuItems, orderItems, orders, payments, restaurants, users, type OrderStatus } from './schema.js';

export const SEED_PASSWORD = 'Password123!';

export const IDS = {
  rahul: '11111111-1111-4111-8111-111111111111',
  aman: '22222222-2222-4222-8222-222222222222',
  owner: '33333333-3333-4333-8333-333333333333',
  admin: '44444444-4444-4444-8444-444444444444',
  spiceGarden: 'aaaaaaaa-0000-4000-8000-000000000001',
  chaiPoint: 'aaaaaaaa-0000-4000-8000-000000000002',
  biryaniHouse: 'aaaaaaaa-0000-4000-8000-000000000003',
  rahulPlacedOrder: 'bbbbbbbb-0000-4000-8000-000000000001',
} as const;

export async function seed(db: Db) {
  await db.execute(sql`truncate payment.payments, ordering.order_items, ordering.orders, restaurant.menu_items,
    restaurant.restaurants, identity.refresh_tokens, identity.users cascade`);

  const passwordHash = await hashPassword(SEED_PASSWORD);
  await db.insert(users).values([
    { id: IDS.rahul, email: 'rahul@tadka.test', displayName: 'Rahul', role: 'Customer', passwordHash },
    { id: IDS.aman, email: 'aman@tadka.test', displayName: 'Aman', role: 'Customer', passwordHash },
    { id: IDS.owner, email: 'owner@tadka.test', displayName: 'Spice Garden Owner', role: 'RestaurantOwner', restaurantId: IDS.spiceGarden, passwordHash },
    { id: IDS.admin, email: 'admin@tadka.test', displayName: 'Tadka Admin', role: 'Admin', passwordHash },
  ]);

  await db.insert(restaurants).values([
    { id: IDS.spiceGarden, name: 'Spice Garden', city: 'Pune' },
    { id: IDS.chaiPoint, name: 'Chai Point', city: 'Mumbai' },
    { id: IDS.biryaniHouse, name: 'Biryani House', city: 'Hyderabad' },
  ]);
  const menu = await db.insert(menuItems).values([
    { restaurantId: IDS.spiceGarden, name: 'Paneer Butter Masala', pricePaise: 29900 },
    { restaurantId: IDS.spiceGarden, name: 'Butter Naan', pricePaise: 4900 },
    { restaurantId: IDS.chaiPoint, name: 'Masala Chai', pricePaise: 3900 },
    { restaurantId: IDS.chaiPoint, name: 'Vada Pav', pricePaise: 2900 },
    { restaurantId: IDS.biryaniHouse, name: 'Chicken Biryani', pricePaise: 34900 },
    { restaurantId: IDS.biryaniHouse, name: 'Veg Biryani', pricePaise: 24900 },
  ]).returning();

  // Each customer: one order per in-flight status, each with a captured payment.
  const statuses: OrderStatus[] = ['Confirmed', 'Preparing', 'OutForDelivery', 'Delivered'];
  const customers = [
    { id: IDS.rahul, address: 'Flat 12, Test Lane, Pune 411001', phone: '+91 00000 00001' },
    { id: IDS.aman, address: 'House 7, Sample Road, Mumbai 400001', phone: '+91 00000 00002' },
  ];
  let n = 0;
  for (const c of customers) {
    for (const status of statuses) {
      const item = menu[n % menu.length]!;
      const [o] = await db.insert(orders).values({
        customerId: c.id, restaurantId: item.restaurantId, status, totalPaise: item.pricePaise * 2,
        deliveryAddress: c.address, contactPhone: c.phone, createdAt: new Date(Date.UTC(2026, 9, 1, 12, n)),
      }).returning();
      await db.insert(orderItems).values({ orderId: o!.id, menuItemId: item.id, name: item.name, unitPricePaise: item.pricePaise, quantity: 2 });
      await db.insert(payments).values({
        orderId: o!.id, amountPaise: o!.totalPaise, capturedPaise: o!.totalPaise, status: 'captured',
        providerKey: `charge:${o!.id}`, providerChargeId: `seed_${n}`,
      });
      n++;
    }
  }

  // M0 addition: one unpaid order, so the probe can show a real charge through the fake provider.
  const paneer = menu[0]!;
  await db.insert(orders).values({
    id: IDS.rahulPlacedOrder, customerId: IDS.rahul, restaurantId: paneer.restaurantId, status: 'Placed',
    totalPaise: paneer.pricePaise, deliveryAddress: customers[0]!.address, contactPhone: customers[0]!.phone,
    createdAt: new Date(Date.UTC(2026, 9, 1, 13, 0)),
  });
  await db.insert(orderItems).values({ orderId: IDS.rahulPlacedOrder, menuItemId: paneer.id, name: paneer.name, unitPricePaise: paneer.pricePaise, quantity: 1 });
}
