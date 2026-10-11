import { and, asc, count, eq } from 'drizzle-orm';
import type { Db } from '../shared/db.js';
import { NotFoundError } from '../shared/errors.js';
import { menuItems, restaurants } from '../shared/schema.js';

export class RestaurantsService {
  constructor(private readonly db: Db) {}

  list() {
    return this.db.select().from(restaurants).orderBy(asc(restaurants.name));
  }

  async menu(restaurantId: string) {
    const [r] = await this.db.select().from(restaurants).where(eq(restaurants.id, restaurantId));
    if (!r) throw new NotFoundError('restaurant_not_found');
    const items = await this.db.select().from(menuItems).where(eq(menuItems.restaurantId, restaurantId)).orderBy(asc(menuItems.name));
    return { restaurant: r, items };
  }

  // A bounded menu for the assistant: at most `limit` items in a fixed order (name, then id),
  // with the total so the caller can say the list is partial.
  async menuPage(restaurantId: string, limit: number, opts: { vegOnly?: boolean } = {}) {
    const [r] = await this.db.select().from(restaurants).where(eq(restaurants.id, restaurantId));
    if (!r) throw new NotFoundError('restaurant_not_found');
    const where = opts.vegOnly ? and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.isVeg, true)) : eq(menuItems.restaurantId, restaurantId);
    const items = await this.db.select().from(menuItems).where(where).orderBy(asc(menuItems.name), asc(menuItems.id)).limit(limit);
    const [{ total }] = await this.db.select({ total: count() }).from(menuItems).where(where) as [{ total: number }];
    return { restaurant: r, items, totalItems: total };
  }
}
