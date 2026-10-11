import type { OrderStatus } from '../shared/schema.js';

// Allowed moves. Anything not listed is rejected, including moving backwards.
const NEXT: Record<OrderStatus, readonly OrderStatus[]> = {
  Placed: ['Confirmed', 'Cancelled'],
  Confirmed: ['Preparing', 'Cancelled'],
  Preparing: ['OutForDelivery'],
  OutForDelivery: ['Delivered'],
  Delivered: [],
  Cancelled: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => NEXT[from].includes(to);
