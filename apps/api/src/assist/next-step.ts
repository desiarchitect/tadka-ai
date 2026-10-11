// What the application does after the model has classified a message. The model chose a
// label; this file decides the action. Nothing here cancels, refunds or changes an order,
// and nothing here reads a user id from the model or the request body.
import type { OrdersService } from '../orders/service.js';
import type { Principal } from '../shared/principal.js';
import type { Intent } from './intent.js';

export type NextStep =
  | { action: 'order_status'; order: { orderId: string; status: string } }
  | { action: 'choose_order'; message: string; orders: { orderId: string; status: string }[] }
  | { action: 'no_active_orders'; message: string }
  | { action: 'unsupported'; message: string }
  | { action: 'clarify'; message: string }
  | { action: 'fallback'; message: string };

export const FALLBACK: NextStep = {
  action: 'fallback',
  message: 'Sorry, I could not understand that. A person from Tadka support will help you.',
};

// Only the part of the orders service this file may use. listActive enforces ownership for
// the principal, so an intent can never widen what the caller sees.
export type OrdersForAssist = Pick<OrdersService, 'listActive'>;

export async function nextStep(p: Principal, intent: Intent, orders: OrdersForAssist): Promise<NextStep> {
  switch (intent) {
    case 'order_status': {
      // A lookup failure throws and becomes a 500. It is never reported as "no orders".
      const active = (await orders.listActive(p)).map((o) => ({ orderId: o.id, status: o.status }));
      if (active.length === 0) return { action: 'no_active_orders', message: 'You have no active orders right now.' };
      // Never guess which order the customer means.
      if (active.length > 1) return { action: 'choose_order', message: 'Which order do you mean?', orders: active };
      return { action: 'order_status', order: active[0]! };
    }
    case 'cancel_order':
      return { action: 'unsupported', message: 'Cancelling an order is not available here yet. A person from Tadka support will help you.' };
    case 'refund_request':
      return { action: 'unsupported', message: 'Refunds are not available here yet. A person from Tadka support will help you.' };
    case 'menu_question':
      return { action: 'unsupported', message: 'Menu questions are not supported in this episode. Open the restaurant menu instead.' };
    case 'other':
      return { action: 'clarify', message: 'Could you tell us a little more about what you need?' };
  }
}
