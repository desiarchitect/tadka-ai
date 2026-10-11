// One Postgres database, one schema per module. No foreign keys cross a schema:
// modules refer to each other by ID only, so a module can move out later.
import { sql } from 'drizzle-orm';
import { check, index, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const identity = pgSchema('identity');
export const restaurant = pgSchema('restaurant');
export const ordering = pgSchema('ordering');
export const payment = pgSchema('payment');

export const users = identity.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<Role>().notNull(),
  restaurantId: uuid('restaurant_id'), // set only for RestaurantOwner
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('users_role_ck', sql`${t.role} in ('Customer', 'RestaurantOwner', 'Admin')`)]);

export const refreshTokens = identity.table('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  familyId: uuid('family_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  parentId: uuid('parent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('refresh_tokens_family_ix').on(t.familyId)]);

export const restaurants = restaurant.table('restaurants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  city: text('city').notNull(),
});

export const menuItems = restaurant.table('menu_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: uuid('restaurant_id').notNull().references(() => restaurants.id),
  name: text('name').notNull(),
  pricePaise: integer('price_paise').notNull(),
}, (t) => [check('menu_items_price_ck', sql`${t.pricePaise} > 0`)]);

export const ORDER_STATUSES = ['Placed', 'Confirmed', 'Preparing', 'OutForDelivery', 'Delivered', 'Cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type Role = 'Customer' | 'RestaurantOwner' | 'Admin';

export const orders = ordering.table('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull(),   // identity.users.id, by ID only
  restaurantId: uuid('restaurant_id').notNull(), // restaurant.restaurants.id, by ID only
  status: text('status').$type<OrderStatus>().notNull(),
  totalPaise: integer('total_paise').notNull(),
  version: integer('version').notNull().default(1),
  deliveryAddress: text('delivery_address').notNull(),
  contactPhone: text('contact_phone').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('orders_status_ck', sql`${t.status} in ('Placed', 'Confirmed', 'Preparing', 'OutForDelivery', 'Delivered', 'Cancelled')`),
  index('orders_customer_ix').on(t.customerId),
  index('orders_restaurant_ix').on(t.restaurantId),
]);

export const orderItems = ordering.table('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  menuItemId: uuid('menu_item_id').notNull(),
  name: text('name').notNull(),
  unitPricePaise: integer('unit_price_paise').notNull(),
  quantity: integer('quantity').notNull(),
});

export const payments = payment.table('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().unique(),
  amountPaise: integer('amount_paise').notNull(),
  capturedPaise: integer('captured_paise').notNull().default(0),
  refundedPaise: integer('refunded_paise').notNull().default(0),
  reservedPaise: integer('reserved_paise').notNull().default(0),
  status: text('status').$type<'pending' | 'captured' | 'declined' | 'unknown'>().notNull(),
  providerChargeId: text('provider_charge_id'),
  providerKey: text('provider_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('payments_status_ck', sql`${t.status} in ('pending', 'captured', 'declined', 'unknown')`),
  // Single-row money invariant. The application keeps it true; this CHECK catches bugs.
  check('payments_amounts_ck', sql`${t.capturedPaise} >= 0 and ${t.refundedPaise} >= 0 and ${t.reservedPaise} >= 0
    and ${t.capturedPaise} <= ${t.amountPaise} and ${t.refundedPaise} + ${t.reservedPaise} <= ${t.capturedPaise}`),
]);
