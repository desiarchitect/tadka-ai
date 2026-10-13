import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), headers: new Headers(headers), json: async () => body });
const R1 = '11111111-0000-4000-8000-000000000001';
const PLACED = 'bbbbbbbb-0000-4000-8000-000000000001';
const AMAN = 'cccccccc-0000-4000-8000-000000000009';
const order = (id: string, status: string, total: number) => ({ id, restaurantId: R1, status, totalPaise: total, version: 1, createdAt: '2026-10-01T13:00:00.000Z', deliveryAddress: 'x' });
const ORDERS: Record<string, unknown[]> = { 'token-rahul': [order(PLACED, 'Preparing', 29900)], 'token-aman': [order(AMAN, 'Delivered', 5800)] };
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
const ANSWER = { answer: `Your order bbbbbbbb is being prepared. Total: Rs 299.00. Placed on 2026-10-01.`, stopReason: 'answered', steps: [{ tool: 'get_my_orders', status: 'ok' }, { tool: 'get_order', status: 'ok' }] };
const FALLBACK = "Sorry, I can't answer that right now. You can check your orders on the Orders page.";
const ask = () => fireEvent.click(screen.getByRole('button', { name: /^Ask/ }));
/** The failure card. (The page also has a static banner with role=alert, so the role alone is not enough.) */
const failureCard = async () => (await screen.findByText('The assistant could not answer')).closest('[role="alert"]') as HTMLElement;
const ready = () => screen.findByText('Preparing');
const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${new URL(c[0] as string).pathname}`);

beforeEach(() => { vi.stubEnv('VITE_DEMO_LOGIN', '1'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('EP-2 tool-calling card', () => {
  it('sends only the question and the token, and shows the answer and the tools that ran as two separate things', async () => {
    const f = api({ 'POST /assist/chat': () => reply(200, ANSWER) });
    globalThis.fetch = f;
    render(<App />);
    await ready();
    ask();
    const region = await screen.findByRole('region', { name: 'Assistant answer' });
    expect(within(region).getByText(/Answer \(written by the server from the tool results\)/)).toBeInTheDocument();
    expect(within(region).getByText(/is being prepared/)).toBeInTheDocument();
    expect(within(region).getByText('Tools the server ran for you')).toBeInTheDocument();
    expect(within(region).getByText('Read your recent orders')).toBeInTheDocument();
    expect(within(region).getByText('get_order')).toBeInTheDocument();
    expect(within(region).getAllByText('ok')).toHaveLength(2);
    const call = f.mock.calls.find((c) => new URL(c[0] as string).pathname === '/assist/chat')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ text: 'Where is my food?' }); // no user id, no order id, no role
    expect(tokenOf(call[1] as RequestInit)).toBe('token-rahul');
    expect(region.textContent).not.toMatch(/arguments|orderId|userId/); // the API sends no tool arguments, so none are shown
  });

  it('shows a not-found step as what it is, without treating it as an error (ownership is the server\'s call)', async () => {
    globalThis.fetch = api({ 'POST /assist/chat': () => reply(200, { answer: "I couldn't find that order.", stopReason: 'answered', steps: [{ tool: 'get_order', status: 'not_found' }] }) });
    render(<App />);
    await ready(); ask();
    const region = await screen.findByRole('region', { name: 'Assistant answer' });
    expect(within(region).getByText("I couldn't find that order.")).toBeInTheDocument();
    expect(within(region).getByText('not found')).toBeInTheDocument();
    expect(screen.queryByText('The assistant could not answer')).not.toBeInTheDocument();
  });

  it.each([
    [429, 'provider_rate_limited', /provider is busy/],
    [502, 'provider_auth', /could not answer right now/],
    [502, 'provider_unavailable', /could not answer right now/],
    [502, 'provider_bad_output', /usable answer/],
    [502, 'provider_refused', /usable answer/],
    [504, 'provider_timeout', /took too long/],
    [504, 'turn_timeout', /took too long/],
    [503, 'budget_exhausted', /spending guard/],
    [503, 'backend_unavailable', /could not fetch your data/],
    [503, 'assistant_not_configured', /not configured/],
    [403, 'customers_only', /Only customer accounts/],
    [400, 'invalid_request', /Invalid question/],
  ])('%i %s is a FAILED turn: the page\'s own wording in an alert, and no answer region, even though the server also sent the fallback sentence', async (status, code, message) => {
    globalThis.fetch = api({ 'POST /assist/chat': () => reply(status, { error: code, answer: FALLBACK, stopReason: 'provider_error', steps: [{ tool: 'get_my_orders', status: 'ok' }] }) });
    render(<App />);
    await ready(); ask();
    const alert = await failureCard();
    expect(within(alert).getByText(message)).toBeInTheDocument();
    expect(within(alert).getByText(/not an answer/)).toBeInTheDocument();
    expect(within(alert).getByText('Tools that ran before it stopped')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Assistant answer' })).not.toBeInTheDocument();
    expect(alert.textContent).not.toContain(code); // the code is for the developer panel, not the user
  });

  it('the rate limiter\'s body (error only) and its Retry-After are used: "try again in about N seconds"', async () => {
    globalThis.fetch = api({ 'POST /assist/chat': () => reply(429, { error: 'rate_limited' }, { 'retry-after': '41' }) });
    render(<App />);
    await ready(); ask();
    const alert = await failureCard();
    expect(alert).toHaveTextContent(/asking too fast/);
    expect(alert).toHaveTextContent('Try again in about 41 seconds.');
    expect(within(alert).queryByText(/Tools that ran/)).not.toBeInTheDocument();
  });

  it('a failure body that is garbage still gives a clear failure, never an answer', async () => {
    globalThis.fetch = api({ 'POST /assist/chat': () => reply(502, '<html>bad gateway</html>') });
    render(<App />);
    await ready(); ask();
    expect(await failureCard()).toHaveTextContent(/Server error while answering/);
    expect(screen.queryByRole('region', { name: 'Assistant answer' })).not.toBeInTheDocument();
  });

  it('a 200 that does not match the contract (unknown tool status, no steps) is a handled error', async () => {
    for (const bad of [{ answer: 'x', stopReason: 'answered', steps: [{ tool: 'get_order', status: 'teleported' }] }, { answer: 'x', stopReason: 'answered' }, { stopReason: 'answered', steps: [] }]) {
      globalThis.fetch = api({ 'POST /assist/chat': () => reply(200, bad) });
      render(<App />);
      await ready(); ask();
      expect(await screen.findByText(/could not understand/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Assistant answer' })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('a 401 ends the session (orders cleared, sign-in form back) and shows no answer', async () => {
    globalThis.fetch = api({ 'POST /assist/chat': () => reply(401, { error: 'invalid_token' }) });
    render(<App />);
    await ready(); ask();
    expect((await screen.findAllByText('Your session has ended. Please sign in again.')).length).toBeGreaterThan(0);
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Assistant answer' })).not.toBeInTheDocument();
  });

  it('Cancel aborts the request (so the server stops the turn) and shows no error; only this card shows Cancel', async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = api({ 'POST /assist/chat': (init) => new Promise((_res, rej) => { seen = init.signal as AbortSignal; init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); }) });
    render(<App />);
    await ready(); ask();
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1); // the other cards are locked, with no Cancel of their own
    expect(screen.getByRole('button', { name: 'Classify intent →' })).toBeDisabled();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Ask/ })).toBeEnabled());
    expect(seen?.aborted).toBe(true);
    expect(screen.queryByText('The assistant could not answer')).not.toBeInTheDocument();
  });

  it('switching customer mid-question aborts it, clears the old answer, and a late answer is never shown', async () => {
    let signal: AbortSignal | undefined; let late: (v: unknown) => void = () => undefined;
    globalThis.fetch = api({ 'POST /assist/chat': (init) => new Promise((resolve) => { signal = init.signal as AbortSignal; late = resolve; }) });
    render(<App />);
    await ready(); ask();
    await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as Aman' }));
    expect(signal?.aborted).toBe(true);
    late(reply(200, ANSWER)); // the old customer's answer arrives after the switch
    expect(await screen.findByText('₹58.00')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Assistant answer' })).not.toBeInTheDocument();
    expect(screen.queryByText(/is being prepared/)).not.toBeInTheDocument();
  });

  it('switching customer clears a shown answer and a shown failure', async () => {
    globalThis.fetch = api({ 'POST /assist/chat': () => reply(200, ANSWER) });
    render(<App />);
    await ready(); ask();
    await screen.findByRole('region', { name: 'Assistant answer' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as Aman' }));
    expect(screen.queryByRole('region', { name: 'Assistant answer' })).not.toBeInTheDocument();
    await screen.findByText('₹58.00');
    globalThis.fetch = api({ 'POST /assist/chat': () => reply(503, { error: 'budget_exhausted', answer: FALLBACK, steps: [] }) });
  });

  it('the capability list shows EP-0, EP-1 and EP-2 as available in this build', async () => {
    globalThis.fetch = api();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByText('What can the assistant do in this build?'));
    for (const t of [/EP-0 · Triage/, /EP-1 · Structured intent/, /EP-2 · Tool lookup/]) expect(screen.getByText(t).parentElement).toHaveTextContent('Available');
  });

  it('without a session (production build) the card is locked and says why; no request is made', async () => {
    vi.stubEnv('VITE_DEMO_LOGIN', '');
    const f = api(); globalThis.fetch = f;
    render(<App />);
    await screen.findByText(/demo sign-in is switched off/i);
    expect(screen.getByRole('button', { name: /^Ask/ })).toBeDisabled();
    expect(calls(f).some((c) => c.includes('/assist/'))).toBe(false);
  });
});
