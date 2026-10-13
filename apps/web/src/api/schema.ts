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
  // `isVeg` is sent from EP-3 on. Absent or false: nothing is claimed about the dish (false is also the column's default, not proof of non-veg).
  items: z.array(z.object({ id: z.string(), restaurantId: z.string(), name: z.string(), pricePaise: z.number().int(), isVeg: z.boolean().optional() })),
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

// ---- EP-3: conversations and the saved preference ----
export const ConversationSummarySchema = z.object({ conversationId: z.string(), turnCount: z.number().int(), createdAt: z.string(), lastMessageAt: z.string() });
export const ConversationListSchema = z.array(ConversationSummarySchema);
export const ConversationCreatedSchema = z.object({ conversationId: z.string() });
/** What the customer saw: their questions and the answers. The API never sends tool internals here. */
export const ConversationHistorySchema = z.object({
  conversationId: z.string(),
  turns: z.array(z.object({ turnNo: z.number().int(), text: z.string(), answer: z.string(), stopReason: z.string(), at: z.string() })),
});
const ContextSchema = z.object({ turnsSent: z.number().int(), turnsDropped: z.number().int(), historyBytes: z.number().int() });
export const ConversationReplySchema = z.object({
  answer: z.string(), stopReason: z.string(), steps: z.array(z.object({ tool: z.string(), status: z.enum(['ok', 'not_found', 'invalid_args', 'failed']) })),
  context: ContextSchema,
});
/** The only saved preference there is: an opt-in vegetarian filter, applied by the server when it shows a menu. */
export const PrefsSchema = z.object({ diet: z.literal('vegetarian').optional() });

// ---- EP-2: /assist/chat ----
export const CHAT_TOOL_STATUSES = ['ok', 'not_found', 'invalid_args', 'failed'] as const;
const ChatStepSchema = z.object({ tool: z.string(), status: z.enum(CHAT_TOOL_STATUSES) });
/** A 200: the server answered. `answer` is rendered by the server from tool results (the model writes none of it). Arguments and results of the tools are not sent. */
export const ChatResponseSchema = z.object({ answer: z.string(), stopReason: z.string(), steps: z.array(ChatStepSchema) });
/** A non-2xx: `error` is the machine-readable code. `answer` is the fixed fallback sentence, which is NOT an answer. The rate limiter sends `error` only. */
export const ChatFailureBodySchema = z.object({ error: z.string(), answer: z.string().optional(), stopReason: z.string().optional(), steps: z.array(ChatStepSchema).optional() });
