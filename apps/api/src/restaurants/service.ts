import { asc, eq } from 'drizzle-orm';
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
}
