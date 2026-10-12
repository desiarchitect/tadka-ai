import type { Order } from '../api/types.js';

/** Paise to rupees, always two decimals. The API sends integer paise. */
export const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

export const orderDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

export const shortId = (id: string): string => id.slice(0, 8);

const LABELS: Record<Order['status'], string> = {
  Placed: 'Placed, awaiting payment',
  Confirmed: 'Confirmed',
  Preparing: 'Preparing',
  OutForDelivery: 'Out for delivery',
  Delivered: 'Delivered',
  Cancelled: 'Cancelled',
};
export const statusLabel = (s: Order['status']): string => LABELS[s];

/** For a status that arrives as plain text (the lookup routes send it unvalidated): the friendly label, or the text itself. */
export const statusLabelOr = (s: string): string => (LABELS as Record<string, string>)[s] ?? s;
