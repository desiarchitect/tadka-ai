import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, statusText: String(status), headers: new Headers(), json: async () => body,
});
const R1 = '11111111-0000-4000-8000-000000000001';
const R2 = '22222222-0000-4000-8000-000000000002';
const RESTAURANTS = [{ id: R1, name: 'Spice Garden', city: 'Pune' }, { id: R2, name: 'Chai Point', city: 'Mumbai' }];
const order = (id: string, restaurantId: string, status: string, totalPaise: number) => ({
  id, restaurantId, status, totalPaise, version: 1, createdAt: '2026-10-01T13:00:00.000Z', customerId: 'c', deliveryAddress: '12 Test Lane, Pune', contactPhone: '+91 90000 00000',
});
const RAHUL_PLACED = 'bbbbbbbb-0000-4000-8000-000000000001';
const RAHUL_PREP = 'dddddddd-0000-4000-8000-000000000002';
const AMAN_ORDER = 'cccccccc-0000-4000-8000-000000000009';
const ORDERS: Record<string, unknown[]> = {
  'token-rahul': [order(RAHUL_PLACED, R1, 'Placed', 29900), order(RAHUL_PREP, R2, 'Preparing', 7800)],
  'token-aman': [order(AMAN_ORDER, R2, 'Delivered', 5800)],
};
const tokenOf = (init: RequestInit) => String((init.headers as Record<string, string> | undefined)?.['Authorization'] ?? '').replace('Bearer ', '');
const loginFor = (email: string) => reply(200, { accessToken: email.startsWith('aman') ? 'token-aman' : 'token-rahul', refreshToken: email.startsWith('aman') ? 'refresh-aman' : 'refresh-rahul', expiresIn: 900 });

type Handler = (init: RequestInit, url: URL) => unknown;
/** A stand-in API with the same ownership rule as the real one: the token decides which orders come back. */
function api(over: Record<string, Handler> = {}) {
  const fn = vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const generic = Object.entries(over).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)));
    if (over[key]) return over[key]!(init, url);
    if (generic) return generic[1](init, url);
    if (key === 'POST /auth/login') return loginFor(JSON.parse(String(init.body)).email);
    if (key === 'POST /auth/logout') return reply(204, null);
    if (key === 'GET /restaurants') return reply(200, RESTAURANTS);
    if (key === 'GET /orders') return reply(200, ORDERS[tokenOf(init)] ?? []);
    const detail = /^GET \/orders\/(.+)$/.exec(key);
    if (detail) {
      const o = (ORDERS[tokenOf(init)] ?? []).find((x) => (x as { id: string }).id === detail[1]);
      return o ? reply(200, { ...(o as object), items: [{ id: 'i1', name: 'Paneer Butter Masala', unitPricePaise: 29900, quantity: 1 }] }) : reply(404, { error: 'order_not_found' });
    }
    const menu = /^GET \/restaurants\/(.+)\/menu$/.exec(key);
    if (menu) return reply(200, { restaurant: RESTAURANTS[0], items: [{ id: 'm1', restaurantId: menu[1], name: 'Butter Naan', pricePaise: 4900 }, { id: 'm2', restaurantId: menu[1], name: 'Dal Tadka', pricePaise: 18000 }] });
    throw new Error(`unexpected request ${key}`);
  });
  return fn as unknown as typeof fn & typeof fetch;
}
const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${new URL(c[0] as string).pathname}`);
const signedInAs = (name: RegExp) => waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());

beforeEach(() => { vi.stubEnv('VITE_DEMO_LOGIN', '1'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('orders', () => {
  it('shows the signed-in customer\'s orders with restaurant, status and total, read from the API', async () => {
    const f = api(); globalThis.fetch = f;
    render(<App />);
    await screen.findByText('Order bbbbbbbb · ' + new Date('2026-10-01T13:00:00.000Z').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }));
    const ordersPanel = within(screen.getByRole('tabpanel', { name: 'Orders' }));
    expect(ordersPanel.getByText('Spice Garden')).toBeInTheDocument(); // the name comes from GET /restaurants, matched by restaurantId
    expect(ordersPanel.getByText('Chai Point')).toBeInTheDocument();
    expect(screen.getByText('Placed, awaiting payment')).toBeInTheDocument();
    expect(screen.getByText('₹299.00')).toBeInTheDocument();
    expect(screen.getByText('Preparing')).toBeInTheDocument();
    expect(calls(f)).toContain('GET /orders');
    expect(calls(f)).toContain('GET /restaurants');
  });

  it('expanding an order reads its items from GET /orders/:id', async () => {
    const f = api(); globalThis.fetch = f;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Details for order bbbbbbbb/ }));
    await screen.findByText('Paneer Butter Masala');
    expect(calls(f)).toContain(`GET /orders/${RAHUL_PLACED}`);
    expect(screen.getByText(/12 Test Lane/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Hide details/ }));
    expect(screen.queryByText('Paneer Butter Masala')).not.toBeInTheDocument();
  });

  it('has an empty state', async () => {
    globalThis.fetch = api({ 'GET /orders': () => reply(200, []) });
    render(<App />);
    expect(await screen.findByText('You have no orders yet.')).toBeInTheDocument();
  });

  it('shows loading, then an error with Retry that works', async () => {
    let n = 0;
    globalThis.fetch = api({ 'GET /orders': () => (++n === 1 ? reply(500, { error: 'internal_error' }) : reply(200, ORDERS['token-rahul'])) });
    render(<App />);
    expect(await screen.findByText('Could not load your orders')).toBeInTheDocument();
    expect(screen.getByText(/The server had a problem/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('₹299.00')).toBeInTheDocument();
    expect(screen.queryByText('Could not load your orders')).not.toBeInTheDocument();
  });

  it('a network failure is an error with Retry, not a crash', async () => {
    globalThis.fetch = api({ 'GET /orders': () => { throw new TypeError('fetch failed'); } });
    render(<App />);
    expect(await screen.findByText('Could not load your orders')).toBeInTheDocument();
    expect(screen.getByText(/Unable to reach the Tadka API/)).toBeInTheDocument();
  });

  it('a 401 on the orders ends the session: orders are cleared and the sign-in form comes back', async () => {
    globalThis.fetch = api({ 'GET /orders': () => reply(401, { error: 'invalid_token' }) });
    render(<App />);
    expect(await screen.findAllByText('Your session has ended. Please sign in again.')).not.toHaveLength(0);
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Sign in to see your orders.')).toBeInTheDocument();
  });
});

describe('diagnostics wording', () => {
  it('a successful sign-in (no model call) is not described as a failed request', async () => {
    globalThis.fetch = api();
    render(<App />);
    await screen.findByText('₹299.00');
    expect(screen.getByText('No model involved in this request')).toBeInTheDocument();
    expect(screen.queryByText('Unavailable on failed request')).not.toBeInTheDocument();
  });

  it('a call that may involve a model but does not say which (triage without a model id) never claims "no model involved"', async () => {
    globalThis.fetch = api({ 'POST /assist/triage': () => reply(200, { output: { intent: 'other', language: 'en', needsHuman: false, summary: 's' }, simulated: false, modelId: 'gpt-x' }) });
    render(<App />);
    await screen.findByText('₹299.00');
    fireEvent.click(screen.getByRole('button', { name: /Submit to Assistant/i }));
    await screen.findByText('gpt-x');
    expect(screen.queryByText('No model involved in this request')).not.toBeInTheDocument();
  });
});

describe('session expiry', () => {
  it('a 401 on a quiet refresh (the list stays on screen) still ends the session', async () => {
    let expired = false;
    globalThis.fetch = api({ 'GET /orders': (init) => (expired ? reply(401, { error: 'invalid_token' }) : reply(200, ORDERS[tokenOf(init)])) });
    render(<App />);
    await screen.findByText('₹299.00');
    expired = true;
    fireEvent.click(screen.getByRole('button', { name: /Refresh orders/ }));
    expect((await screen.findAllByText('Your session has ended. Please sign in again.')).length).toBeGreaterThan(0);
    expect(screen.queryByText('₹299.00')).not.toBeInTheDocument();
  });

  it('a 401 while paying ends the session and shows nothing as paid', async () => {
    globalThis.fetch = api({ 'POST /orders/*': () => reply(401, { error: 'invalid_token' }) });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Pay ₹299.00/ }));
    expect((await screen.findAllByText('Your session has ended. Please sign in again.')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Payment received/)).not.toBeInTheDocument();
    expect(screen.queryByText('₹299.00')).not.toBeInTheDocument();
  });
});

describe('customer switching', () => {
  it('Rahul to Aman: the in-flight request is aborted, nothing of Rahul remains, and Aman\'s own orders are fetched with Aman\'s token', async () => {
    let rahulSignal: AbortSignal | undefined;
    let rahulResolve: (v: unknown) => void = () => undefined;
    let first = true;
    const f = api({
      'GET /orders': (init) => {
        if (tokenOf(init) === 'token-rahul' && first) {
          first = false;
          rahulSignal = init.signal as AbortSignal;
          return new Promise((resolve) => { rahulResolve = resolve; }); // Rahul's list is still "in flight"
        }
        return reply(200, ORDERS[tokenOf(init)] ?? []);
      },
    });
    globalThis.fetch = f;
    render(<App />);
    await screen.findByText('Loading your orders…');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as Aman' }));
    expect(rahulSignal?.aborted).toBe(true);
    rahulResolve(reply(200, ORDERS['token-rahul'])); // a late answer from the old session
    await signedInAs(/Aman \(Customer\)/);
    expect(await screen.findByText('₹58.00')).toBeInTheDocument();
    expect(screen.queryByText('₹299.00')).not.toBeInTheDocument();
    expect(screen.queryByText(/bbbbbbbb/)).not.toBeInTheDocument();
    const orderCalls = f.mock.calls.filter((c) => new URL(c[0] as string).pathname === '/orders');
    expect(orderCalls.map((c) => tokenOf(c[1] as RequestInit))).toEqual(['token-rahul', 'token-aman']);
    expect(calls(f)).toContain('POST /auth/logout'); // Rahul's refresh token was revoked
    const logout = f.mock.calls.find((c) => new URL(c[0] as string).pathname === '/auth/logout')!;
    expect(JSON.parse(String((logout[1] as RequestInit).body))).toEqual({ refreshToken: 'refresh-rahul' });
  });

  it('switching clears Rahul\'s order list, details and assistant result before Aman\'s data arrives', async () => {
    let release: (v: unknown) => void = () => undefined;
    const f = api({
      'POST /assist/triage': () => reply(200, { output: { intent: 'order_status', language: 'en', needsHuman: false, summary: 'RAHUL-ONLY SUMMARY' }, simulated: false, modelId: 'm' }),
      'GET /orders': (init) => (tokenOf(init) === 'token-aman' ? new Promise((r) => { release = r; }) : reply(200, ORDERS['token-rahul'])),
    });
    globalThis.fetch = f;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Details for order bbbbbbbb/ }));
    await screen.findByText('Paneer Butter Masala');
    fireEvent.click(screen.getByRole('button', { name: /Submit to Assistant/i }));
    await screen.findByText('RAHUL-ONLY SUMMARY');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as Aman' }));
    await screen.findByText('Loading your orders…'); // Aman's list is pending
    expect(screen.queryByText('RAHUL-ONLY SUMMARY')).not.toBeInTheDocument();
    expect(screen.queryByText('Paneer Butter Masala')).not.toBeInTheDocument();
    expect(screen.queryByText('₹299.00')).not.toBeInTheDocument();
    expect(screen.queryByText('Placed, awaiting payment')).not.toBeInTheDocument();
    release(reply(200, ORDERS['token-aman']));
    expect(await screen.findByText('₹58.00', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('Sign Out clears the orders and revokes the refresh token', async () => {
    const f = api(); globalThis.fetch = f;
    render(<App />);
    await screen.findByText('₹299.00');
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    expect(await screen.findByText('Sign in to see your orders.')).toBeInTheDocument();
    expect(screen.queryByText('₹299.00')).not.toBeInTheDocument();
    expect(calls(f)).toContain('POST /auth/logout');
  });
});

describe('payment', () => {
  it('pays a Placed order once: two quick clicks send one request, and the order becomes Confirmed with no Pay button', async () => {
    let paid = false;
    const f = api({
      'POST /orders/*': () => { paid = true; return reply(200, order(RAHUL_PLACED, R1, 'Confirmed', 29900)); },
      'GET /orders': (init) => reply(200, paid ? [order(RAHUL_PLACED, R1, 'Confirmed', 29900), ORDERS['token-rahul']![1]] : ORDERS[tokenOf(init)]),
    });
    globalThis.fetch = f;
    render(<App />);
    const pay = await screen.findByRole('button', { name: /Pay ₹299.00/ });
    fireEvent.click(pay); fireEvent.click(pay);
    expect(await screen.findByText('Payment received. Your order is confirmed.')).toBeInTheDocument();
    expect(calls(f).filter((c) => c === `POST /orders/${RAHUL_PLACED}/pay`)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Pay ₹/ })).not.toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it('under React StrictMode (development) the payment request is still sent', async () => {
    const f = api({ 'POST /orders/*': () => reply(200, order(RAHUL_PLACED, R1, 'Confirmed', 29900)) });
    globalThis.fetch = f;
    render(<StrictMode><App /></StrictMode>);
    fireEvent.click(await screen.findByRole('button', { name: /Pay ₹299.00/ }));
    expect(await screen.findByText('Payment received. Your order is confirmed.')).toBeInTheDocument();
    expect(calls(f).filter((c) => c === `POST /orders/${RAHUL_PLACED}/pay`)).toHaveLength(1);
  });

  it('only a Placed order offers Pay (the server still decides)', async () => {
    globalThis.fetch = api();
    render(<App />);
    await screen.findByText('Placed, awaiting payment');
    expect(screen.getAllByRole('button', { name: /^Pay ₹/ })).toHaveLength(1);
  });

  it('a conflict (the order moved on) is explained, nothing is shown as paid, and the list is refreshed', async () => {
    let moved = false;
    globalThis.fetch = api({
      'POST /orders/*': () => { moved = true; return reply(409, { error: 'order_is_Preparing' }); },
      'GET /orders': (init) => reply(200, moved ? [order(RAHUL_PLACED, R1, 'Preparing', 29900)] : ORDERS[tokenOf(init)]),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Pay ₹299.00/ }));
    expect(await screen.findByText('This order is now Preparing and can no longer be paid.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Pay ₹/ })).not.toBeInTheDocument());
    expect(screen.queryByText('Payment received. Your order is confirmed.')).not.toBeInTheDocument();
  });

  it('a declined payment says so and leaves the order payable', async () => {
    globalThis.fetch = api({ 'POST /orders/*': () => reply(402, { error: 'payment_declined' }) });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Pay ₹299.00/ }));
    expect(await screen.findByText('The payment was declined. You were not charged.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay ₹299.00/ })).toBeEnabled();
  });

  it('an unknown payment outcome (502) is not reported as success or as a decline', async () => {
    globalThis.fetch = api({ 'POST /orders/*': () => reply(502, { error: 'payment_outcome_unknown' }) });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Pay ₹299.00/ }));
    expect(await screen.findByText(/could not confirm the payment/)).toBeInTheDocument();
    expect(screen.queryByText(/declined|received/)).not.toBeInTheDocument();
  });
});

describe('restaurants and menus', () => {
  it('lists restaurants, opens a menu with real names and prices, and shows no dietary tags', async () => {
    const f = api(); globalThis.fetch = f;
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Restaurants' }));
    fireEvent.click(await screen.findByRole('button', { name: /Show menu for Spice Garden/ }));
    const menu = await screen.findByRole('list', { name: 'Spice Garden menu' });
    expect(within(menu).getByText('Butter Naan')).toBeInTheDocument();
    expect(within(menu).getByText('₹49.00')).toBeInTheDocument();
    expect(within(menu).getByText('₹180.00')).toBeInTheDocument();
    expect(calls(f)).toContain(`GET /restaurants/${R1}/menu`);
    expect(screen.queryByText(/vegetarian|vegan|spicy|jain/i)).not.toBeInTheDocument();
  });

  it('a menu error offers Retry', async () => {
    let n = 0;
    globalThis.fetch = api({ 'GET /restaurants/*': () => (++n === 1 ? reply(500, { error: 'x' }) : reply(200, { restaurant: RESTAURANTS[0], items: [] })) });
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Restaurants' }));
    fireEvent.click(await screen.findByRole('button', { name: /Show menu for Spice Garden/ }));
    expect(await screen.findByText('Could not load the menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('This restaurant has no menu items listed.')).toBeInTheDocument();
  });

  it('a restaurant-list error and an empty list are both handled', async () => {
    globalThis.fetch = api({ 'GET /restaurants': () => reply(503, { error: 'x' }) });
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Restaurants' }));
    expect(await screen.findByText('Could not load restaurants')).toBeInTheDocument();
    cleanup();
    globalThis.fetch = api({ 'GET /restaurants': () => reply(200, []) });
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Restaurants' }));
    expect(await screen.findByText('No restaurants are listed right now.')).toBeInTheDocument();
  });

  it('tabs work with the arrow keys', async () => {
    globalThis.fetch = api();
    render(<App />);
    const orders = await screen.findByRole('tab', { name: 'Orders' });
    orders.focus();
    fireEvent.keyDown(orders, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Restaurants' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Restaurants' })).toHaveFocus();
  });
});

describe('typed sign-in (a build without the demo accounts)', () => {
  beforeEach(() => { vi.stubEnv('VITE_DEMO_LOGIN', ''); });

  it('signs in with an email and password through POST /auth/login, then loads that customer\'s orders', async () => {
    const f = api(); globalThis.fetch = f;
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'aman@tadka.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'whatever' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('₹58.00')).toBeInTheDocument();
    expect(screen.getByText(/Signed in \(aman@tadka.test\)/)).toBeInTheDocument();
    expect(JSON.parse(String((f.mock.calls.find((c) => new URL(c[0] as string).pathname === '/auth/login')![1] as RequestInit).body))).toEqual({ email: 'aman@tadka.test', password: 'whatever' });
  });

  it('a wrong password shows the error, stays signed out, and does not keep the password', async () => {
    globalThis.fetch = api({ 'POST /auth/login': () => reply(401, { error: 'invalid_credentials' }) });
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByText('Sign in to see your orders.')).toBeInTheDocument();
  });
});
