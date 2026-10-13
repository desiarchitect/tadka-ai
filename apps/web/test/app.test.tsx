import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: ({ 200: 'OK', 401: 'Unauthorized' } as Record<number, string>)[status] ?? String(status),
  headers: new Headers(headers),
  json: async () => body,
});
const login = reply(200, { accessToken: 'token-rahul', refreshToken: 'refresh-rahul', expiresIn: 900 }, { 'x-request-id': 'req-1', 'x-trace-id': 'trace-001' });
const triageBody = (over: Record<string, unknown> = {}) => ({
  output: { intent: 'order_status', language: 'hinglish', needsHuman: false, summary: 'Customer asks why Paneer Butter Masala is 40 minutes late.' },
  usage: { inputTokens: 90, outputTokens: 30 },
  simulated: false,
  modelId: 'gpt-5.4-mini',
  authenticatedAs: { userId: '11111111-1111-4111-8111-111111111111', role: 'Customer' },
  ...over,
});

const RESTAURANTS = [{ id: 'r1', name: 'Spice Garden', city: 'Pune' }];
type Routes = { triage?: unknown[]; extra?: Record<string, (init: RequestInit) => unknown> };
/** A stand-in for the API, routed by method and path. Anything not listed gets the quiet default; an unexpected path fails the test. */
const api = (routes: Routes = {}) => {
  const triage = [...(routes.triage ?? [])];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    if (routes.extra?.[key]) return routes.extra[key]!(init);
    if (key === 'POST /auth/login') return login;
    if (key === 'POST /assist/triage') return triage.shift();
    if (key === 'GET /restaurants') return reply(200, RESTAURANTS);
    if (key === 'GET /orders') return reply(200, []);
    if (key === 'POST /auth/logout') return reply(204, null);
    throw new Error(`unexpected request ${key}`);
  });
  return fn as unknown as typeof fn & typeof fetch;
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: /Submit to Assistant/i }));

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Tadka Visual Client, demo sign-in ON (VITE_DEMO_LOGIN=1)', () => {
  beforeEach(() => { vi.stubEnv('VITE_DEMO_LOGIN', '1'); });

  it('renders Tadka branding, demo notice banner, and initial controls', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(login);
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Tadka Food Assistant')).toBeInTheDocument();
      expect(screen.getByText(/Local Demo & Learning Environment/)).toBeInTheDocument();
      expect(screen.getByText('Customer Inquiry & Support Assistant')).toBeInTheDocument();
      expect(screen.getByText('Developer Demonstration Panel (Real Backend Telemetry)')).toBeInTheDocument();
      expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument();
    });
  });

  it('submits an inquiry and renders the actual backend triage response and diagnostics', async () => {
    const fetchMock = api({ triage: [reply(200, triageBody(), { 'x-request-id': 'req-2', 'x-trace-id': 'trace-xyz-789' })] });
    globalThis.fetch = fetchMock;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument());
    submit();
    await waitFor(() => {
      expect(screen.getByText('Intent: order status')).toBeInTheDocument();
      expect(screen.getByText('Language: hinglish')).toBeInTheDocument();
      expect(screen.getByText('Human Escalation: Not Required')).toBeInTheDocument();
      expect(screen.getByText('Customer asks why Paneer Butter Masala is 40 minutes late.')).toBeInTheDocument();
    });
    expect(screen.getByText('200 OK')).toBeInTheDocument();
    expect(screen.getAllByText('trace-xyz-789').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('req-2')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.4-mini')).toBeInTheDocument();
    expect(screen.getByText(/90 in \/ 30 out/)).toBeInTheDocument();
    expect(screen.queryByText('SIMULATED')).not.toBeInTheDocument(); // a real answer is not labelled simulated

    fireEvent.click(screen.getByRole('button', { name: /Submit Another Inquiry/i }));
    expect(screen.queryByText('Intent: order status')).not.toBeInTheDocument();
  });

  it('shows a visible SIMULATED badge when the server says the answer is simulated', async () => {
    const fetchMock = api({ triage: [reply(200, triageBody({ simulated: true, modelId: 'demo-mock' }))] });
    globalThis.fetch = fetchMock;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument());
    submit();
    await waitFor(() => expect(screen.getByText('SIMULATED')).toBeInTheDocument());
    expect(screen.getByText(/demo-mock/)).toBeInTheDocument();
    expect(screen.getByText(/simulated, not from a real model/)).toBeInTheDocument();
  });

  it('handles 401 unauthenticated request safely without crashing', async () => {
    const fetchMock = api({ triage: [reply(401, { error: 'missing_token' }, { 'x-request-id': 'req-unauth-1', 'x-trace-id': 'trace-unauth-1' })] });
    globalThis.fetch = fetchMock;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument());
    submit();
    await waitFor(() => {
      expect(screen.getByText(/Authentication required/)).toBeInTheDocument();
      expect(screen.getByText('401 Unauthorized')).toBeInTheDocument();
      expect(screen.getByText('missing_token')).toBeInTheDocument();
    });
  });

  it('a provider failure is worded as the provider failing, never as the user needing to sign in', async () => {
    const fetchMock = api({ triage: [reply(502, { error: 'provider_auth' })] });
    globalThis.fetch = fetchMock;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument());
    submit();
    await waitFor(() => expect(screen.getByText(/AI provider could not answer/)).toBeInTheDocument());
    expect(screen.queryByText(/Authentication required/)).not.toBeInTheDocument();
    expect(screen.getByText('provider_auth')).toBeInTheDocument();
  });

  it('a malformed 200 response becomes a handled error, not a crash', async () => {
    const fetchMock = api({ triage: [reply(200, { modelId: 'x' })] }); // no `output`, no `simulated`
    globalThis.fetch = fetchMock;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument());
    submit();
    await waitFor(() => expect(screen.getByRole('alert', { name: '' })).toBeDefined());
    expect(screen.getByText(/could not understand/)).toBeInTheDocument();
    expect(screen.getByText('invalid_response')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit to Assistant/i })).toBeEnabled(); // the user can try again
  });

  it('Cancel stops the request and shows no error', async () => {
    let seen: AbortSignal | undefined;
    const fetchMock = api({ extra: { 'POST /assist/triage': (init) => new Promise((_res, rej) => {
      seen = init.signal as AbortSignal;
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }) } });
    globalThis.fetch = fetchMock;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument());
    submit();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit to Assistant/i })).toBeEnabled());
    expect(seen?.aborted).toBe(true);
    expect(screen.queryByText('Request Unsuccessful')).not.toBeInTheDocument();
  });

  it('under React StrictMode (which runs the sign-in effect twice) the first sign-in is cancelled, the second wins, and the page ends up signed in and idle', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = api({ extra: { 'POST /auth/login': (init) => new Promise((resolve, reject) => {
      const sig = init.signal as AbortSignal;
      signals.push(sig);
      if (sig.aborted) return reject(new DOMException('aborted', 'AbortError'));
      sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      // answer only the call that is still live after StrictMode's remount
      setTimeout(() => { if (!sig.aborted) resolve(login); }, 20);
    }) } });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.filter((x) => !x.aborted)).toHaveLength(1); // exactly one sign-in survived
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit to Assistant/i })).toBeEnabled());
    expect(screen.queryByText('Request Unsuccessful')).not.toBeInTheDocument();
  });

  it('Sign Out then submit demonstrates the 401 without a token', async () => {
    const fetchMock = api({ triage: [reply(401, { error: 'missing_token' })] });
    globalThis.fetch = fetchMock;
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    submit();
    await waitFor(() => expect(screen.getByText(/Authentication required/)).toBeInTheDocument());
    const init = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/assist/triage'))![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });
});

describe('Tadka Visual Client, demo sign-in OFF (a production build)', () => {
  beforeEach(() => { vi.stubEnv('VITE_DEMO_LOGIN', ''); });

  it('does not sign in, does not call the API, and explains that the assistant is unavailable', async () => {
    const fetchMock = api();
    globalThis.fetch = fetchMock;
    render(<App />);
    await screen.findByText(/demo sign-in is switched off/i);
    expect(screen.getAllByText(/Sign in to use the assistant/).length).toBeGreaterThan(0); // the triage card and the EP-1 intent card both say it
    expect(screen.getByRole('button', { name: /Submit to Assistant/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Sign in as/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/rahul@tadka.test/)).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    // The restaurants are public and are read; nothing is signed in, so no auth, order or assistant request is made.
    expect(fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${new URL(c[0]).pathname}`)).toEqual(['GET /restaurants']);
  });

  it('even a stray VITE_DEMO_LOGIN value other than "1" does not switch it on', async () => {
    vi.stubEnv('VITE_DEMO_LOGIN', 'true');
    const fetchMock = api();
    globalThis.fetch = fetchMock;
    render(<App />);
    await screen.findByText(/demo sign-in is switched off/i);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.some((c) => new URL(c[0]).pathname.startsWith('/auth'))).toBe(false);
  });
});

describe('Tadka Visual Client, a production build made without VITE_API_URL', () => {
  it('says what is missing, disables the form and sends nothing, even with the demo sign-in switched on', async () => {
    vi.stubEnv('VITE_DEMO_LOGIN', '1');
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('DEV', false);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    render(<App />);
    await screen.findAllByText(/no API address/i);
    expect(screen.getAllByText(/VITE_API_URL=https:\/\/api\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Submit to Assistant/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Sign in as/i })).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
