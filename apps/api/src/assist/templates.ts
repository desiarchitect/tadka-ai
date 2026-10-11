// Every sentence the assistant can say in EP2. The model never writes user-visible text: it
// picks which tool results answer the question, and these templates render them from the
// validated fields. So an order status, a total or a price can only come from a tool result.
import type { ModelResult } from './tools/executor.js';
import type { ToolData } from './tools/views.js';

export const FALLBACK = "Sorry, I can't answer that right now. You can check your orders on the Orders page.";
export const FAILED = "I couldn't fetch that right now. Please try again in a moment.";
export const NOT_FOUND = { get_order: "I couldn't find that order.", get_restaurant_menu: "I couldn't find that restaurant." } as const;
export const CLARIFY = {
  which_order: 'Which order do you mean? You can find the order id on the Orders page.',
  which_restaurant: 'Which restaurant do you mean?',
  unsupported_request: 'I can only look up your orders and restaurant menus here.',
} as const;
export type ClarifyReason = keyof typeof CLARIFY;

const STATUS_TEXT: Record<string, string> = {
  Placed: 'placed and waiting for payment', Confirmed: 'confirmed', Preparing: 'being prepared',
  OutForDelivery: 'out for delivery', Delivered: 'delivered', Cancelled: 'cancelled',
};
const rupees = (paise: number) => `Rs ${(paise / 100).toFixed(2)}`;
const day = (iso: string) => iso.slice(0, 10);
const short = (id: string) => id.slice(0, 8);
const status = (s: string) => STATUS_TEXT[s] ?? 'in an unknown state';

function renderData(d: ToolData): string {
  if (d.kind === 'order') {
    const o = d.order;
    return `Your order ${short(o.orderId)} is ${status(o.status)}. Total: ${rupees(o.totalPaise)}. Placed on ${day(o.placedAt)}.`;
  }
  if (d.kind === 'orders') {
    if (!d.orders.length) return 'You have no orders yet.';
    const lines = d.orders.map((o) => `- ${short(o.orderId)}: ${status(o.status)}, ${rupees(o.totalPaise)}, placed on ${day(o.placedAt)}`);
    return ['Your recent orders, newest first:', ...lines, ...(d.hasMore ? ['Older orders are not shown.'] : [])].join('\n');
  }
  const lines = d.items.map((i) => `- ${i.name}: ${rupees(i.pricePaise)}`);
  const partial = d.truncated ? [`Showing ${d.items.length} of ${d.totalItems} items.`] : [];
  return [`${d.restaurant.name} (${d.restaurant.city}) menu:`, ...lines, ...partial].join('\n');
}

export function renderResult(tool: string, r: ModelResult): string | null {
  if (r.status === 'ok') return renderData(r.data);
  if (r.status === 'not_found') return NOT_FOUND[tool as keyof typeof NOT_FOUND] ?? FAILED;
  if (r.status === 'failed') return FAILED;
  return null; // invalid_args is never shown to the user
}

export function renderAll(results: { tool: string; result: ModelResult }[]): string {
  const parts = [...new Set(results.map((r) => renderResult(r.tool, r.result)).filter((t): t is string => t !== null))];
  return parts.length ? parts.join('\n\n') : FALLBACK;
}
