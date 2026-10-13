// What the client accepts from the API. TypeScript casts do not check data at run time; these do.
// Unknown extra fields are dropped; a missing or wrongly typed field is a handled error, not a crash.
import { z } from 'zod';

export const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string(),
  expiresIn: z.number(),
});

export const TriageResponseSchema = z.object({
  output: z.object({
    intent: z.enum(['order_status', 'refund_request', 'menu_question', 'complaint', 'other']),
    language: z.enum(['en', 'hi', 'hinglish']),
    needsHuman: z.boolean(),
    summary: z.string(),
  }),
  usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
  /** true: the server is in demo mode and nothing here came from a real model. */
  simulated: z.boolean(),
  modelId: z.string(),
  authenticatedAs: z.object({ userId: z.string(), role: z.string() }).optional(),
});

export const ErrorBodySchema = z.object({ error: z.string() });

// ---- Product data (restaurants, menus, orders). Only the fields the API really sends; nothing is invented. ----
export const ORDER_STATUSES = ['Placed', 'Confirmed', 'Preparing', 'OutForDelivery', 'Delivered', 'Cancelled'] as const;

export const RestaurantSchema = z.object({ id: z.string(), name: z.string(), city: z.string() });
export const RestaurantListSchema = z.array(RestaurantSchema);
export const MenuSchema = z.object({
  restaurant: RestaurantSchema,
  items: z.array(z.object({ id: z.string(), restaurantId: z.string(), name: z.string(), pricePaise: z.number().int() })),
});

export const OrderSchema = z.object({
  id: z.string(),
  restaurantId: z.string(),
  status: z.enum(ORDER_STATUSES),
  totalPaise: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  deliveryAddress: z.string().nullish(),
  contactPhone: z.string().nullish(),
});
export const OrderListSchema = z.array(OrderSchema);
export const OrderDetailSchema = OrderSchema.extend({
  items: z.array(z.object({ id: z.string(), name: z.string(), unitPricePaise: z.number().int(), quantity: z.number().int() })),
});

/** POST /auth/logout answers 204 with no body. */
export const NoContentSchema = z.null();

// ---- EP-1: /assist/intent (classification) and /assist/order-status (a direct lookup, no model) ----
export const INTENTS = ['order_status', 'cancel_order', 'refund_request', 'menu_question', 'other'] as const;
const OrderRef = z.object({ orderId: z.string(), status: z.string() });
export const NextStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('order_status'), order: OrderRef }),
  z.object({ action: z.literal('choose_order'), message: z.string(), orders: z.array(OrderRef) }),
  z.object({ action: z.literal('no_active_orders'), message: z.string() }),
  z.object({ action: z.literal('unsupported'), message: z.string() }),
  z.object({ action: z.literal('clarify'), message: z.string() }),
  z.object({ action: z.literal('fallback'), message: z.string() }),
]);
/** `intent` is present only when `outcome` is "ok". The server sends no confidence score, and none is shown. */
export const IntentResponseSchema = z.object({
  outcome: z.string(),
  classifier: z.enum(['llm', 'rules']),
  simulated: z.boolean(),
  intent: z.enum(INTENTS).optional(),
  next: NextStepSchema,
});
export const OrderStatusResponseSchema = OrderRef;
