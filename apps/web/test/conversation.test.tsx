import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), headers: new Headers(headers), json: async () => body });
const R1 = '11111111-0000-4000-8000-000000000001';
const order = (id: string) => ({ id, restaurantId: R1, status: 'Preparing', totalPaise: 9800, version: 1, createdAt: '2026-10-01T13:00:00.000Z', deliveryAddress: 'x' });
const tokenOf = (init: RequestInit) => String((init.headers as Record<string, string> | undefined)?.['Authorization'] ?? '').replace('Bearer ', '');
const FALLBACK = "Sorry, I can't answer that right now. You can check your orders on the Orders page.";

type Turn = { turnNo: number; text: string; answer: string; stopReason: string; at: string };
type Conv = { id: string; turns: Turn[] };
type Handler = (init: RequestInit, url: URL) => unknown;

/** A small in-memory stand-in for the server's conversation API, with the same ownership rule: the token decides whose conversations exist. */
function server(over: Record<string, Handler> = {}, seed: Record<string, Conv[]> = {}) {
  const convs: Record<string, Conv[]> = { 'token-rahul': [], 'token-aman': [], ...seed };
  const prefs: Record<string, { diet?: 'vegetarian' }> = { 'token-rahul': {}, 'token-aman': {} };
  let n = 0;
  const summary = (c: Conv) => ({ conversationId: c.id, turnCount: c.turns.length, createdAt: '2026-10-01T12:00:00.000Z', lastMessageAt: '2026-10-01T13:00:00.000Z' });
  const find = (t: string, id: string) => convs[t]?.find((c) => c.id === id);
  const fn = vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = new URL(u); const method = init.method ?? 'GET'; const key = `${method} ${url.pathname}`; const t = tokenOf(init);
    if (over[key]) return over[key]!(init, url);
    if (key === 'POST /auth/login') { const aman = JSON.parse(String(init.body)).email.startsWith('aman'); return reply(200, { accessToken: aman ? 'token-aman' : 'token-rahul', refreshToken: aman ? 'r-a' : 'r-r', expiresIn: 900 }); }
    if (key === 'POST /auth/logout') return reply(204, null);
    if (key === 'GET /restaurants') return reply(200, [{ id: R1, name: 'Spice Garden', city: 'Pune' }]);
    if (key === 'GET /orders') return reply(200, t === 'token-aman' ? [order('cccccccc-0000-4000-8000-000000000009')] : [order('bbbbbbbb-0000-4000-8000-000000000001')]);
    if (key === 'GET /assist/memories') return reply(200, prefs[t] ?? {});
    if (key === 'PUT /assist/memories/diet') { prefs[t] = { diet: 'vegetarian' }; return reply(200, prefs[t]); }
    if (key === 'DELETE /assist/memories/diet') { prefs[t] = {}; return reply(204, null); }
    if (key === 'GET /assist/conversations') return reply(200, (convs[t] ?? []).map(summary));
    if (key === 'POST /assist/conversations') { const c = { id: `0000000${++n}-0000-4000-8000-000000000000`, turns: [] }; convs[t]!.push(c); return reply(201, { conversationId: c.id }); }
    let m = /^GET \/assist\/conversations\/(.+)$/.exec(key);
    if (m) { const c = find(t, m[1]!); return c ? reply(200, { conversationId: c.id, turns: c.turns }) : reply(404, { error: 'conversation_not_found' }); }
    m = /^DELETE \/assist\/conversations\/(.+)$/.exec(key);
    if (m) { const c = find(t, m[1]!); if (!c) return reply(404, { error: 'conversation_not_found' }); convs[t] = convs[t]!.filter((x) => x !== c); return reply(204, null); }
    m = /^POST \/assist\/conversations\/(.+)\/messages$/.exec(key);
    if (m) {
      const c = find(t, m[1]!); if (!c) return reply(404, { error: 'conversation_not_found' });
      const text = JSON.parse(String(init.body)).text as string;
      const turnNo = c.turns.length + 1;
      c.turns.push({ turnNo, text, answer: `Answer ${turnNo} for: ${text}`, stopReason: 'answered', at: '2026-10-01T13:00:00.000Z' });
      return reply(200, { answer: `Answer ${turnNo} for: ${text}`, stopReason: 'answered', steps: [{ tool: 'get_my_orders', status: 'ok' }], context: { turnsSent: turnNo - 1, turnsDropped: 0, historyBytes: 120 } });
    }
    throw new Error(`unexpected request ${key}`);
  });
  return Object.assign(fn as unknown as typeof fn & typeof fetch, { convs, prefs });
}
const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${new URL(c[0] as string).pathname}`);
const ready = () => screen.findByText('Show only vegetarian dishes when the assistant reads a menu');
const card = () => screen.getByRole('heading', { name: /Conversations/ }).closest('section')!;
const startConv = async () => { fireEvent.click(screen.getByRole('button', { name: 'New conversation' })); await screen.findByText('Nothing here yet. Ask your first question.'); };
const sendMsg = (text: string) => { fireEvent.change(screen.getByLabelText('Your message:'), { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: /^Send/ })); };
const failureCard = async () => (await screen.findAllByText('The assistant could not answer')).map((e) => e.closest('[role="alert"]') as HTMLElement).at(-1)!;

beforeEach(() => { vi.stubEnv('VITE_DEMO_LOGIN', '1'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('EP-3 conversations', () => {
  it('starts with no conversations, creates one through the API, and a follow-up is sent with the token and only the text', async () => {
    const f = server(); globalThis.fetch = f;
    render(<App />);
    await ready();
    expect(await screen.findByText('You have no conversations yet.')).toBeInTheDocument();
    await startConv();
    expect(calls(f)).toContain('POST /assist/conversations');
    sendMsg('Where is my food?');
    await screen.findByText(/Answer 1 for: Where is my food\?/);
    const call = f.mock.calls.find((c) => String(c[0]).endsWith('/messages'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ text: 'Where is my food?' }); // no user id, conversation history or order id
    expect(tokenOf(call[1] as RequestInit)).toBe('token-rahul');
    const details = await screen.findByRole('region', { name: 'Latest turn details' });
    expect(within(details).getByText('get_my_orders')).toBeInTheDocument();
    expect(within(details).getByText('The model was given 0 earlier turns of this conversation.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your message:')).toHaveValue('');
    sendMsg('and the menu?');
    await screen.findByText(/Answer 2 for: and the menu\?/);
    expect(await screen.findByText('The model was given 1 earlier turn of this conversation.')).toBeInTheDocument();
    // what is on screen is what the server stored: the transcript is re-read from GET /assist/conversations/:id
    expect(calls(f).filter((c) => c === 'GET /assist/conversations/00000001-0000-4000-8000-000000000000').length).toBeGreaterThanOrEqual(2);
  });

  it('says honestly when older turns were left out to fit the history budget', async () => {
    const g = server();
    const base = g.getMockImplementation()!;
    g.mockImplementation(async (u: string, init: RequestInit = {}) => {
      if (String(u).endsWith('/messages')) return reply(200, { answer: 'ok', stopReason: 'answered', steps: [], context: { turnsSent: 3, turnsDropped: 2, historyBytes: 1400 } });
      return base(u, init);
    });
    globalThis.fetch = g;
    render(<App />);
    await ready(); await startConv(); sendMsg('hi');
    expect(await screen.findByText(/2 older turns were left out to stay within the history budget/)).toBeInTheDocument();
  });

  it('opens an existing conversation from the list and shows its stored turns', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    const f = server({}, { 'token-rahul': [{ id, turns: [{ turnNo: 1, text: 'Earlier question', answer: 'Earlier answer', stopReason: 'answered', at: 'x' }, { turnNo: 2, text: 'A failed one', answer: FALLBACK, stopReason: 'provider_error', at: 'x' }] }] });
    globalThis.fetch = f;
    render(<App />);
    await ready();
    const list = await screen.findByRole('list', { name: 'Your conversations' });
    expect(within(list).getByText('Conversation aaaaaaaa')).toBeInTheDocument();
    expect(within(list).getByText(/2 turns/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: /Open conversation aaaaaaaa/ }));
    expect(await screen.findByText('Earlier question')).toBeInTheDocument();
    expect(screen.getByText('Earlier answer')).toBeInTheDocument();
    // a stored failed turn is shown as a failure, not as an answer
    expect(screen.getByText(/This question could not be answered \(provider error\)/)).toBeInTheDocument();
    expect(calls(f)).toContain(`GET /assist/conversations/${id}`);
  });

  it('a failed turn is a failure in the page\'s own words, with Retry-After, and the stored failed turn appears in the transcript', async () => {
    const f = server();
    const base = f.getMockImplementation()!;
    let failNext = true;
    f.mockImplementation(async (u: string, init: RequestInit = {}) => {
      if (String(u).endsWith('/messages') && failNext) {
        failNext = false;
        const c = [...Object.values(f.convs)].flat().at(-1)!;
        c.turns.push({ turnNo: 1, text: 'q', answer: FALLBACK, stopReason: 'provider_error', at: 'x' }); // the server stores a failed turn too
        return reply(429, { error: 'provider_rate_limited', answer: FALLBACK, stopReason: 'provider_error', steps: [{ tool: 'get_my_orders', status: 'ok' }] }, { 'retry-after': '9' });
      }
      return base(u, init);
    });
    globalThis.fetch = f;
    render(<App />);
    await ready(); await startConv(); sendMsg('q');
    const alert = await failureCard();
    expect(alert).toHaveTextContent(/provider is busy/);
    expect(alert).toHaveTextContent('Try again in about 9 seconds.');
    expect(within(alert).getByText('Tools that ran before it stopped')).toBeInTheDocument();
    expect(await screen.findByText(/This question could not be answered \(provider error\)/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Latest turn details' })).not.toBeInTheDocument();
  });

  it.each([
    [409, 'conversation_busy', /answered first/],
    [409, 'conversation_full', /limit of 50 turns/],
    [409, 'invalid_history', /can no longer be continued/],
    [503, 'budget_exhausted', /spending guard/],
    [504, 'turn_timeout', /took too long/],
  ])('%i %s has its own wording and the page does not show the code', async (status, code, message) => {
    const f = server();
    const base = f.getMockImplementation()!;
    f.mockImplementation(async (u: string, init: RequestInit = {}) => (String(u).endsWith('/messages') ? reply(status, { error: code }) : base(u, init)));
    globalThis.fetch = f;
    render(<App />);
    await ready(); await startConv(); sendMsg('q');
    const alert = await failureCard();
    expect(alert).toHaveTextContent(message);
    expect(alert.textContent).not.toContain(code);
  });

  it('a 404 for the conversation (deleted elsewhere) returns to the list; a 401 ends the session', async () => {
    const f = server();
    const base = f.getMockImplementation()!;
    let status = 404;
    f.mockImplementation(async (u: string, init: RequestInit = {}) => (String(u).endsWith('/messages') ? reply(status, { error: status === 404 ? 'conversation_not_found' : 'invalid_token' }) : base(u, init)));
    globalThis.fetch = f;
    render(<App />);
    await ready(); await startConv(); sendMsg('q');
    expect(await screen.findByText('Start a new conversation, or open one from the list.')).toBeInTheDocument();
    await startConv();
    status = 401; sendMsg('q');
    expect((await screen.findAllByText('Your session has ended. Please sign in again.')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /Conversations/ })).not.toBeInTheDocument();
  });

  it('deleting takes two steps and only then calls the API; the list is refreshed', async () => {
    const f = server(); globalThis.fetch = f;
    render(<App />);
    await ready(); await startConv(); sendMsg('hello');
    await screen.findByText(/Answer 1/);
    fireEvent.click(screen.getByRole('button', { name: 'Delete this conversation' }));
    expect(calls(f).some((c) => c.startsWith('DELETE /assist/conversations'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.getByRole('button', { name: 'Delete this conversation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete this conversation' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm: delete it and its turns/ }));
    expect(await screen.findByText('You have no conversations yet.')).toBeInTheDocument();
    expect(calls(f).filter((c) => c.startsWith('DELETE /assist/conversations'))).toHaveLength(1);
    expect(screen.queryByText(/Answer 1/)).not.toBeInTheDocument();
  });

  it('Cancel aborts a message in flight and shows no error', async () => {
    let seen: AbortSignal | undefined;
    const f = server();
    const base = f.getMockImplementation()!;
    f.mockImplementation((u: string, init: RequestInit = {}) => String(u).endsWith('/messages')
      ? new Promise((_r, rej) => { seen = init.signal as AbortSignal; init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); })
      : base(u, init));
    globalThis.fetch = f;
    render(<App />);
    await ready(); await startConv(); sendMsg('slow');
    const section = card();
    fireEvent.click(await within(section).findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(section).getByRole('button', { name: /^Send/ })).toBeEnabled());
    expect(seen?.aborted).toBe(true);
    expect(screen.queryByText('The assistant could not answer')).not.toBeInTheDocument();
  });
});

describe('EP-3 saved preference', () => {
  it('is loaded from the server; ticking it saves it (PUT {value: vegetarian}); unticking deletes it', async () => {
    const f = server(); globalThis.fetch = f;
    render(<App />);
    const box = await screen.findByRole('checkbox', { name: /vegetarian dishes/ });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/It is off\./)).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    const put = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')!;
    expect(String(put[0])).toMatch(/\/assist\/memories\/diet$/);
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ value: 'vegetarian' });
    expect(f.prefs['token-rahul']).toEqual({ diet: 'vegetarian' }); // stored on the server, not in the page
    expect(screen.getByText(/menus the assistant reads are filtered by the server/)).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(calls(f)).toContain('DELETE /assist/memories/diet');
    expect(f.prefs['token-rahul']).toEqual({});
  });

  it('shows what the server already has after a load error with Retry, and a save error leaves the box as the server has it', async () => {
    let n = 0;
    const g = server(); g.prefs['token-rahul'] = { diet: 'vegetarian' };
    const base = g.getMockImplementation()!;
    g.mockImplementation(async (u: string, init: RequestInit = {}) => (String(u).endsWith('/assist/memories') && (init.method ?? 'GET') === 'GET' && ++n === 1 ? reply(500, { error: 'x' }) : base(u, init)));
    globalThis.fetch = g;
    render(<App />);
    expect(await screen.findByText('Could not load your preference')).toBeInTheDocument();
    fireEvent.click(within(screen.getByText('Could not load your preference').closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }));
    const box = await screen.findByRole('checkbox', { name: /vegetarian dishes/ });
    expect(box).toBeChecked();
    g.mockImplementation(async (u: string, init: RequestInit = {}) => ((init.method ?? 'GET') === 'DELETE' && String(u).endsWith('/memories/diet') ? reply(500, { error: 'x' }) : base(u, init)));
    fireEvent.click(box);
    expect(await screen.findByText(/Server error while answering/)).toBeInTheDocument();
    expect(box).toBeChecked(); // the server still has it, so the page still shows it
  });
});

describe('EP-3 customer switching', () => {
  it('Rahul to Aman: his conversations, transcript, preference and any message in flight are gone before Aman\'s are loaded', async () => {
    let signal: AbortSignal | undefined; let late: (v: unknown) => void = () => undefined;
    const f = server({}, { 'token-aman': [{ id: 'dddddddd-0000-4000-8000-000000000009', turns: [] }] });
    f.prefs['token-rahul'] = { diet: 'vegetarian' };
    const base = f.getMockImplementation()!;
    f.mockImplementation((u: string, init: RequestInit = {}) => String(u).endsWith('/messages') && tokenOf(init) === 'token-rahul'
      ? new Promise((resolve) => { signal = init.signal as AbortSignal; late = resolve; })
      : base(u, init));
    globalThis.fetch = f;
    render(<App />);
    await screen.findByRole('checkbox', { name: /vegetarian dishes/ });
    await startConv(); sendMsg('Rahul only');
    await within(card()).findByRole('button', { name: 'Cancel' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as Aman' }));
    expect(signal?.aborted).toBe(true);
    late(reply(200, { answer: 'RAHUL LATE ANSWER', stopReason: 'answered', steps: [], context: { turnsSent: 0, turnsDropped: 0, historyBytes: 0 } }));
    const list = await screen.findByRole('list', { name: 'Your conversations' });
    expect(within(list).getByText('Conversation dddddddd')).toBeInTheDocument();
    expect(within(list).queryByText('Conversation 00000001')).not.toBeInTheDocument();
    expect(screen.queryByText('Rahul only')).not.toBeInTheDocument();
    expect(screen.queryByText('RAHUL LATE ANSWER')).not.toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /vegetarian dishes/ })).not.toBeChecked(); // Aman's own preference, read from the server
    const aman = f.mock.calls.filter((c) => tokenOf(c[1] as RequestInit) === 'token-aman').map((c) => `${(c[1] as RequestInit).method ?? 'GET'} ${new URL(c[0] as string).pathname}`);
    expect(aman).toContain('GET /assist/conversations');
    expect(aman).toContain('GET /assist/memories');
  });

  it('Sign Out removes the whole conversation card', async () => {
    globalThis.fetch = server();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Conversations/ })).not.toBeInTheDocument());
  });

  it('the capability list shows EP-3 as available', async () => {
    globalThis.fetch = server();
    render(<App />);
    await ready();
    fireEvent.click(screen.getByText('What can the assistant do in this build?'));
    expect(screen.getByText(/EP-3 · Conversations and memory/).parentElement).toHaveTextContent('Available');
  });
});
