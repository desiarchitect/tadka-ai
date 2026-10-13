import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), headers: new Headers(), json: async () => body });
const R1 = '11111111-0000-4000-8000-000000000001';
const PLACED = 'bbbbbbbb-0000-4000-8000-000000000001';
const PREP = 'dddddddd-0000-4000-8000-000000000002';
const AMAN = 'cccccccc-0000-4000-8000-000000000009';
const order = (id: string, status: string, total: number) => ({ id, restaurantId: R1, status, totalPaise: total, version: 1, createdAt: '2026-10-01T13:00:00.000Z', deliveryAddress: 'x' });
const ORDERS: Record<string, unknown[]> = { 'token-rahul': [order(PLACED, 'Placed', 29900), order(PREP, 'Preparing', 7800)], 'token-aman': [order(AMAN, 'Delivered', 5800)] };
const tokenOf = (init: RequestInit) => String((init.headers as Record<string, string> | undefined)?.['Authorization'] ?? '').replace('Bearer ', '');
type Handler = (init: RequestInit, url: URL) => unknown;
function api(over: Record<string, Handler> = {}) {
  const fn = vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = new URL(u); const key = `${init.method ?? 'GET'} ${url.pathname}`;
    if (over[key]) return over[key]!(init, url);
    if (key === 'POST /auth/login') { const aman = JSON.parse(String(init.body)).email.startsWith('aman'); return reply(200, { accessToken: aman ? 'token-aman' : 'token-rahul', refreshToken: aman ? 'r-a' : 'r-r', expiresIn: 900 }); }
    if (key === 'POST /auth/logout') return reply(204, null);
    if (key === 'GET /restaurants') return reply(200, [{ id: R1, name: 'Spice Garden', city: 'Pune' }]);
    if (key === 'GET /orders') return reply(200, ORDERS[tokenOf(init)] ?? []);
    throw new Error(`unexpected request ${key}`);
  });
  return fn as unknown as typeof fn & typeof fetch;
}
const intentBody = (over: Record<string, unknown> = {}) => ({ outcome: 'ok', classifier: 'llm', simulated: false, intent: 'order_status', next: { action: 'order_status', order: { orderId: PREP, status: 'Preparing' } }, ...over });
const classify = () => fireEvent.click(screen.getByRole('button', { name: /Classify intent/ }));
const ready = () => screen.findByText('Placed, awaiting payment');

beforeEach(() => { vi.stubEnv('VITE_DEMO_LOGIN', '1'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('EP-1 intent card', () => {
  it('sends only the text, and shows the classification and the server\'s next step as two separate things', async () => {
    const f = api({ 'POST /assist/intent': () => reply(200, intentBody()) });
    globalThis.fetch = f;
    render(<App />);
    await ready();
    classify();
    const region = await screen.findByRole('region', { name: 'Intent classification result' });
    expect(within(region).getByText('1. Classification')).toBeInTheDocument();
    expect(within(region).getByText('order status')).toBeInTheDocument();
    expect(within(region).getByText('2. Next step (chosen by server code, not by the model)')).toBeInTheDocument();
    expect(within(region).getByText('dddddddd')).toBeInTheDocument();
    expect(within(region).getByText('Preparing')).toBeInTheDocument();
    expect(within(region).getByText('Classifier: language model')).toBeInTheDocument();
    expect(within(region).queryByText('SIMULATED')).not.toBeInTheDocument();
    const call = f.mock.calls.find((c) => new URL(c[0] as string).pathname === '/assist/intent')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ text: 'Where is my food? It has been a while.' }); // no user id, no order id
    expect(screen.getByText(/Classification only\./)).toBeInTheDocument();
    expect(region.textContent).not.toMatch(/confidence|score|probab/i); // the API sends none, so none is shown
  });

  it('labels keyword rules as such, and demo answers as SIMULATED', async () => {
    globalThis.fetch = api({ 'POST /assist/intent': () => reply(200, intentBody({ classifier: 'rules', simulated: true })) });
    render(<App />);
    await ready(); classify();
    expect(await screen.findByText('Classifier: keyword rules (no model called)')).toBeInTheDocument();
    expect(screen.getByText('SIMULATED')).toBeInTheDocument();
  });

  it('shows choose_order, clarify, unsupported and a missing intent honestly', async () => {
    const answers = [
      intentBody({ next: { action: 'choose_order', message: 'Which order do you mean?', orders: [{ orderId: PLACED, status: 'Placed' }, { orderId: PREP, status: 'Preparing' }] } }),
      intentBody({ intent: 'cancel_order', next: { action: 'unsupported', message: 'Cancelling an order is not available here yet.' } }),
      { outcome: 'invalid_output', classifier: 'llm', simulated: false, next: { action: 'fallback', message: 'Sorry, I could not understand that.' } },
    ];
    globalThis.fetch = api({ 'POST /assist/intent': () => reply(200, answers.shift()) });
    render(<App />);
    await ready(); classify();
    expect(await screen.findByText('Which order do you mean?')).toBeInTheDocument();
    expect(screen.getByText('Order bbbbbbbb: Placed')).toBeInTheDocument();
    classify();
    expect(await screen.findByText('Cancelling an order is not available here yet.')).toBeInTheDocument();
    expect(screen.getByText('cancel order')).toBeInTheDocument();
    classify();
    expect(await screen.findByText(/No intent was produced \(outcome: invalid output\)/)).toBeInTheDocument();
    expect(screen.getByText('Sorry, I could not understand that.')).toBeInTheDocument();
  });

  it.each([
    [502, 'assistant_unavailable', /classifier could not answer/],
    [403, 'customers_only', /Only customer accounts/],
    [429, 'rate_limited', /Too many requests/],
    [401, 'invalid_token', /Authentication required/],
  ])('%i %s is a handled error, nothing is shown as a result', async (status, code, message) => {
    globalThis.fetch = api({ 'POST /assist/intent': () => reply(status, { error: code }) });
    render(<App />);
    await ready(); classify();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Intent classification result' })).not.toBeInTheDocument();
  });

  it('a malformed answer (unknown action, or no classifier field) is a handled error, not a crash', async () => {
    globalThis.fetch = api({ 'POST /assist/intent': () => reply(200, intentBody({ next: { action: 'refund_now', message: 'x' } })) });
    render(<App />);
    await ready(); classify();
    expect(await screen.findByText(/could not understand/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Intent classification result' })).not.toBeInTheDocument();
  });

  it('switching customer clears the intent result before the next customer\'s data loads', async () => {
    globalThis.fetch = api({ 'POST /assist/intent': () => reply(200, intentBody()) });
    render(<App />);
    await ready(); classify();
    await screen.findByRole('region', { name: 'Intent classification result' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as Aman' }));
    expect(screen.queryByRole('region', { name: 'Intent classification result' })).not.toBeInTheDocument();
    expect(await screen.findByText('₹58.00')).toBeInTheDocument();
  });

  it('the capability list says EP-1 is available in this build and EP-2 is not', async () => {
    globalThis.fetch = api();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByText('What can the assistant do in this build?'));
    expect(screen.getByText(/EP-1 · Structured intent/).parentElement).toHaveTextContent('Available');
    expect(screen.getByText(/EP-2 · Tool lookup/).parentElement).toHaveTextContent('Not in this build');
  });
});

describe('EP-1 developer panel does not misstate whether a model was involved', () => {
  it('rules: "No model involved"; language model: "Not reported by this endpoint" (never a claim that no model was used)', async () => {
    globalThis.fetch = api({ 'POST /assist/intent': () => reply(200, intentBody({ classifier: 'llm' })) });
    render(<App />);
    await ready(); classify();
    await screen.findByRole('region', { name: 'Intent classification result' });
    expect(screen.getByText('Not reported by this endpoint')).toBeInTheDocument();
    expect(screen.queryByText('No model involved in this request')).not.toBeInTheDocument();
    cleanup();
    globalThis.fetch = api({ 'POST /assist/intent': () => reply(200, intentBody({ classifier: 'rules' })) });
    render(<App />);
    await ready(); classify();
    await screen.findByRole('region', { name: 'Intent classification result' });
    expect(screen.getByText('No model involved in this request')).toBeInTheDocument();
  });
});

describe('EP-1 direct order-status lookup (no model)', () => {
  it('asks the server for that order and labels the answer as a direct lookup, not an AI answer', async () => {
    const f = api({ 'GET /assist/order-status': () => reply(200, { orderId: PREP, status: 'Preparing' }) });
    globalThis.fetch = f;
    render(<App />);
    await ready();
    const row = screen.getByText(/Order dddddddd/).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /Check status/ }));
    expect(await within(row).findByText('Direct lookup by the server (no model): Preparing')).toBeInTheDocument();
    const call = f.mock.calls.find((c) => new URL(c[0] as string).pathname === '/assist/order-status')!;
    expect(String(call[0])).toContain(`orderId=${PREP}`);
    expect(tokenOf(call[1] as RequestInit)).toBe('token-rahul');
  });

  it('a lookup the server refuses (404) is an error, and a 401 ends the session', async () => {
    let status = 404;
    globalThis.fetch = api({ 'GET /assist/order-status': () => reply(status, { error: status === 404 ? 'order_not_found' : 'invalid_token' }) });
    render(<App />);
    await ready();
    const row = screen.getByText(/Order dddddddd/).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /Check status/ }));
    expect(await within(row).findByText('That could not be found.')).toBeInTheDocument();
    status = 401;
    fireEvent.click(within(row).getByRole('button', { name: /Check status/ }));
    expect((await screen.findAllByText('Your session has ended. Please sign in again.')).length).toBeGreaterThan(0);
  });

  it('after switching customer the previous lookup answer is gone', async () => {
    globalThis.fetch = api({ 'GET /assist/order-status': () => reply(200, { orderId: PREP, status: 'Preparing' }) });
    render(<App />);
    await ready();
    const row = screen.getByText(/Order dddddddd/).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /Check status/ }));
    await screen.findByText(/Direct lookup by the server/);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as Aman' }));
    await waitFor(() => expect(screen.queryByText(/Direct lookup by the server/)).not.toBeInTheDocument());
    expect(await screen.findByText('₹58.00')).toBeInTheDocument();
  });
});
