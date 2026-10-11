import type { Role } from './schema.js';

// Who is calling. Every service method takes one, so ownership is checked for every
// caller (a route, a script, and later the AI assistant) in the same place.
export type Principal = { userId: string; role: Role; restaurantId?: string };
