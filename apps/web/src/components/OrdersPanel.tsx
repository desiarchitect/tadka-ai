import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';
import type { ApiDiagnostics, Order, Restaurant } from '../api/types.js';
import { useLoad, type Load } from '../hooks/useLoad.js';
import { orderDate, rupees, shortId, statusLabel } from '../lib/format.js';

type Props = {
  token: string;
  restaurants: Load<Restaurant[]>;
  /** The server said 401: the session has ended. */
  onUnauthorized: () => void;
};
type Notice = { kind: 'ok' | 'error'; text: string };

/**
 * The signed-in customer's orders, read from GET /orders. Which orders come back is decided by the server from the token;
 * nothing here filters by customer. The parent keys this component by session, so signing in as someone else unmounts it:
 * its requests are aborted and its state is gone before the next customer's data is requested.
 */
export const OrdersPanel: React.FC<Props> = ({ token, restaurants, onUnauthorized }) => {
  const { state, reload, refresh, update } = useLoad((signal) => apiClient.orders(token, signal), true, (status) => { if (status === 401) onUnauthorized(); });
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [paying, setPaying] = useState<ReadonlySet<string>>(new Set());
  const payingRef = useRef(new Set<string>()); // synchronous guard: two quick clicks send one request
  const alive = useRef(true);
  const payAbort = useRef<AbortController | null>(null);
  // Created in the effect, not once at render: React StrictMode (development) runs the cleanup and then the effect again, and
  // a controller aborted by that first cleanup would cancel every payment before it was sent.
  useEffect(() => {
    alive.current = true;
    payAbort.current = new AbortController();
    return () => { alive.current = false; payAbort.current?.abort(); };
  }, []);

  const names = new Map(restaurants.status === 'ok' ? restaurants.data.map((r) => [r.id, r.name]) : []);
  const note = (id: string, n: Notice | null) => setNotices((cur) => { const next = { ...cur }; if (n) next[id] = n; else delete next[id]; return next; });

  const pay = async (order: Order) => {
    if (payingRef.current.has(order.id)) return;
    payingRef.current.add(order.id);
    setPaying(new Set(payingRef.current));
    note(order.id, null);
    try {
      const res = await apiClient.pay(order.id, token, payAbort.current?.signal);
      if (!alive.current) return;
      update((list) => list.map((o) => (o.id === order.id ? { ...o, ...res.data } : o)));
      note(order.id, { kind: 'ok', text: res.data.status === 'Confirmed' ? 'Payment received. Your order is confirmed.' : `Order is ${statusLabel(res.data.status)}.` });
      refresh();
    } catch (err: unknown) {
      if (!alive.current || (err as Error).name === 'RequestCancelledError') return;
      const diag = (err as { diagnostics?: ApiDiagnostics }).diagnostics;
      if (diag?.httpStatus === 401) { onUnauthorized(); return; }
      note(order.id, { kind: 'error', text: (err as Error).message });
      if (diag?.httpStatus === 409) refresh(); // the order is no longer Placed: show what it is now
    } finally {
      payingRef.current.delete(order.id);
      if (alive.current) setPaying(new Set(payingRef.current));
    }
  };

  return (
    <section aria-labelledby="orders-heading" className="panel">
      <div className="panel-head">
        <h2 id="orders-heading" className="panel-title">Your orders</h2>
        {state.status === 'ok' && <button type="button" className="btn-sm" onClick={refresh}>Refresh<span className="sr-only"> orders</span></button>}
      </div>
      {state.status === 'loading' && <p role="status" className="muted">Loading your orders…</p>}
      {state.status === 'error' && state.httpStatus !== 401 && (
        <div className="error-card" role="alert">
          <div><div className="error-title">Could not load your orders</div><div className="error-msg">{state.message}</div></div>
          <button type="button" className="btn-sm" onClick={reload}>Retry</button>
        </div>
      )}
      {state.status === 'ok' && state.data.length === 0 && <p className="muted">You have no orders yet.</p>}
      {state.status === 'ok' && state.data.length > 0 && (
        <ul className="plain-list">
          {state.data.map((o) => (
            <OrderRow
              key={o.id} order={o} token={token} restaurantName={names.get(o.restaurantId) ?? null}
              notice={notices[o.id] ?? null} paying={paying.has(o.id)} onPay={() => void pay(o)} onUnauthorized={onUnauthorized}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

const OrderRow: React.FC<{
  order: Order; token: string; restaurantName: string | null; notice: Notice | null; paying: boolean; onPay: () => void; onUnauthorized: () => void;
}> = ({ order, token, restaurantName, notice, paying, onPay, onUnauthorized }) => {
  const [open, setOpen] = useState(false);
  const bodyId = `order-${order.id}`;
  const label = restaurantName ?? 'Restaurant';
  return (
    <li className="row-card" data-order-id={order.id}>
      <div className="row-head">
        <div className="row-main">
          <span className="row-title">{label}</span>
          <span className="muted">Order {shortId(order.id)} · {orderDate(order.createdAt)}</span>
        </div>
        <div className="row-side">
          <span className={`status status-${order.status}`}>{statusLabel(order.status)}</span>
          <span className="price">{rupees(order.totalPaise)}</span>
        </div>
      </div>
      <div className="row-actions">
        <button type="button" className="btn-sm" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide details' : 'Details'}<span className="sr-only"> for order {shortId(order.id)} from {label}</span>
        </button>
        {order.status === 'Placed' && (
          <button type="button" className="btn-primary btn-pay" onClick={onPay} disabled={paying} aria-busy={paying}>
            {paying ? 'Paying…' : `Pay ${rupees(order.totalPaise)}`}<span className="sr-only"> for order {shortId(order.id)}</span>
          </button>
        )}
      </div>
      {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`notice notice-${notice.kind}`}>{notice.text}</p>}
      <div id={bodyId} hidden={!open}>{open && <OrderDetails orderId={order.id} token={token} onUnauthorized={onUnauthorized} />}</div>
    </li>
  );
};

// Mounted only while open: every opening reads the order again from GET /orders/:id.
const OrderDetails: React.FC<{ orderId: string; token: string; onUnauthorized: () => void }> = ({ orderId, token, onUnauthorized }) => {
  const { state, reload } = useLoad((signal) => apiClient.order(orderId, token, signal), true, (status) => { if (status === 401) onUnauthorized(); });
  if (state.status === 'loading') return <p role="status" className="muted">Loading order details…</p>;
  if (state.status === 'error') {
    return (
      <div className="error-card" role="alert">
        <div><div className="error-title">Could not load the order</div><div className="error-msg">{state.message}</div></div>
        <button type="button" className="btn-sm" onClick={reload}>Retry</button>
      </div>
    );
  }
  const d = state.data;
  return (
    <div className="detail">
      <table className="items">
        <caption className="sr-only">Items in order {shortId(d.id)}</caption>
        <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col" className="num">Price</th></tr></thead>
        <tbody>
          {d.items.map((i) => (
            <tr key={i.id}><td>{i.name}</td><td>{i.quantity}</td><td className="num">{rupees(i.unitPricePaise * i.quantity)}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><th scope="row" colSpan={2}>Total</th><td className="num">{rupees(d.totalPaise)}</td></tr></tfoot>
      </table>
      {d.deliveryAddress && <p className="muted">Deliver to: {d.deliveryAddress}</p>}
    </div>
  );
};
