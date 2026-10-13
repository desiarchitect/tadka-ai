import React, { useEffect, useRef, useState } from 'react';
import { apiClient, isCancelled } from '../api/client.js';
import type { ApiDiagnostics, ChatFailure, ConversationReply, ConversationSummary } from '../api/types.js';
import { useLoad } from '../hooks/useLoad.js';
import { orderDate } from '../lib/format.js';
import { ToolSteps } from './ToolSteps.js';

type Props = {
  token: string;
  /** The server said 401: the session has ended. */
  onUnauthorized: () => void;
  /** The server's answer to a turn, for the developer panel. */
  onDiagnostics: (d: ApiDiagnostics) => void;
};

const ANSWERED = new Set(['answered', 'clarify', 'history_limit']);
const say = (err: unknown) => (err as Error).message || 'Request failed';
const status401 = (err: unknown) => (err as { diagnostics?: ApiDiagnostics }).diagnostics?.httpStatus === 401;

/**
 * EP-3: conversations the server remembers, and one saved preference. The page keeps no conversation itself: every conversation,
 * turn and preference is read from the API, and the server decides whose they are (another customer's id is a 404). The parent keys
 * this component by session, so signing in as someone else unmounts it: its requests are aborted and its state is gone.
 */
export const ConversationCard: React.FC<Props> = ({ token, onUnauthorized, onDiagnostics }) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fail401 = (s: number) => { if (s === 401) onUnauthorized(); };
  const list = useLoad((signal) => apiClient.conversations(token, signal), true, fail401);
  const alive = useRef(true);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; ctl.current = new AbortController(); return () => { alive.current = false; ctl.current?.abort(); }; }, []);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await work(); } catch (err) {
      if (!alive.current || isCancelled(err)) return;
      if (status401(err)) { onUnauthorized(); return; }
      setMessage(say(err));
    } finally { if (alive.current) setBusy(false); }
  };
  const create = () => guard(async () => {
    const res = await apiClient.createConversation(token, ctl.current?.signal);
    if (!alive.current) return;
    setActiveId(res.data.conversationId); setConfirmDelete(false); list.refresh();
  });
  const remove = () => guard(async () => {
    await apiClient.deleteConversation(activeId!, token, ctl.current?.signal);
    if (!alive.current) return;
    setActiveId(null); setConfirmDelete(false); list.refresh();
  });

  return (
    <section className="customer-card" aria-labelledby="conv-heading">
      <h2 id="conv-heading" className="section-title"><span aria-hidden="true">&#128172;</span> Conversations <span className="status status-Confirmed">EP-3</span></h2>
      <p className="muted"><strong>The server remembers.</strong> Each conversation is stored on the server for you only. The assistant gets your earlier turns (the newest whole turns that fit a size budget) with each new question. Deleting a conversation deletes its turns.</p>
      <Preference token={token} onUnauthorized={onUnauthorized} />
      <div className="row-actions">
        <button type="button" className="btn-primary btn-pay" onClick={() => void create()} disabled={busy}>New conversation</button>
        {activeId && !confirmDelete && <button type="button" className="btn-sm" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete this conversation</button>}
        {activeId && confirmDelete && (
          <>
            <button type="button" className="btn-sm danger" onClick={() => void remove()} disabled={busy}>Confirm: delete it and its turns</button>
            <button type="button" className="btn-sm" onClick={() => setConfirmDelete(false)}>Keep it</button>
          </>
        )}
      </div>
      {message && <p role="alert" className="notice notice-error">{message}</p>}
      <ConversationList list={list} activeId={activeId} onOpen={(id) => { setActiveId(id); setConfirmDelete(false); setMessage(null); }} />
      {activeId
        ? <Transcript key={activeId} id={activeId} token={token} onUnauthorized={onUnauthorized} onDiagnostics={onDiagnostics} onTurn={list.refresh} onGone={() => { setActiveId(null); list.refresh(); }} />
        : <p className="muted">Start a new conversation, or open one from the list.</p>}
    </section>
  );
};

const ConversationList: React.FC<{ list: ReturnType<typeof useLoad<ConversationSummary[]>>; activeId: string | null; onOpen: (id: string) => void }> = ({ list, activeId, onOpen }) => {
  const s = list.state;
  if (s.status === 'loading') return <p role="status" className="muted">Loading your conversations…</p>;
  if (s.status === 'error') {
    return <div className="error-card" role="alert"><div><div className="error-title">Could not load your conversations</div><div className="error-msg">{s.message}</div></div><button type="button" className="btn-sm" onClick={list.reload}>Retry</button></div>;
  }
  if (s.data.length === 0) return <p className="muted">You have no conversations yet.</p>;
  return (
    <ul className="plain-list" aria-label="Your conversations">
      {s.data.map((c) => (
        <li key={c.conversationId} className="row-card">
          <div className="row-head">
            <div className="row-main">
              <span className="row-title">Conversation {c.conversationId.slice(0, 8)}</span>
              <span className="muted">{c.turnCount} {c.turnCount === 1 ? 'turn' : 'turns'} · last message {orderDate(c.lastMessageAt)}</span>
            </div>
            <button type="button" className="btn-sm" aria-pressed={activeId === c.conversationId} onClick={() => onOpen(c.conversationId)}>
              {activeId === c.conversationId ? 'Open' : 'Open'}<span className="sr-only"> conversation {c.conversationId.slice(0, 8)}</span>
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
};

type Last = { reply?: ConversationReply; failure?: { message: string; detail: ChatFailure | null } };

const Transcript: React.FC<{ id: string; token: string; onUnauthorized: () => void; onDiagnostics: (d: ApiDiagnostics) => void; onTurn: () => void; onGone: () => void }> = ({ id, token, onUnauthorized, onDiagnostics, onTurn, onGone }) => {
  const history = useLoad((signal) => apiClient.conversation(id, token, signal), true, (s) => { if (s === 401) onUnauthorized(); });
  const [text, setText] = useState('Where is my food?');
  const [sending, setSending] = useState(false);
  const [last, setLast] = useState<Last | null>(null);
  const flight = useRef<AbortController | null>(null);
  useEffect(() => () => flight.current?.abort(), []);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || !text.trim()) return;
    const c = new AbortController(); flight.current = c;
    setSending(true); setLast(null);
    try {
      const res = await apiClient.say(id, text.trim(), token, c.signal);
      if (c.signal.aborted) return;
      onDiagnostics(res.diagnostics); setLast({ reply: res.data }); setText('');
      history.refresh(); onTurn();
    } catch (err) {
      if (isCancelled(err) || c.signal.aborted) return;
      const diag = (err as { diagnostics?: ApiDiagnostics }).diagnostics;
      if (diag) onDiagnostics(diag);
      if (diag?.httpStatus === 401) { onUnauthorized(); return; }
      if (diag?.httpStatus === 404) { onGone(); return; }
      setLast({ failure: { message: say(err), detail: (err as { failure?: ChatFailure }).failure ?? null } });
      history.refresh(); onTurn(); // the server stores a failed turn too: show what it recorded
    } finally {
      if (flight.current === c) { flight.current = null; setSending(false); }
    }
  };

  const h = history.state;
  return (
    <div className="transcript">
      <h3 className="panel-title">Conversation {id.slice(0, 8)}</h3>
      {h.status === 'loading' && <p role="status" className="muted">Loading the conversation…</p>}
      {h.status === 'error' && <div className="error-card" role="alert"><div><div className="error-title">Could not load this conversation</div><div className="error-msg">{h.message}</div></div><button type="button" className="btn-sm" onClick={history.reload}>Retry</button></div>}
      {h.status === 'ok' && h.data.turns.length === 0 && <p className="muted">Nothing here yet. Ask your first question.</p>}
      {h.status === 'ok' && h.data.turns.length > 0 && (
        <ol className="turns" aria-label="Turns in this conversation">
          {h.data.turns.map((t) => (
            <li key={t.turnNo} className="turn">
              <p className="turn-you"><span className="diag-label">You</span> {t.text}</p>
              {ANSWERED.has(t.stopReason)
                ? <p className="turn-answer"><span className="diag-label">Assistant (written by the server from tool results)</span> {t.answer}</p>
                : <p className="turn-failed muted"><span className="diag-label">No answer</span> This question could not be answered ({t.stopReason.replace(/_/g, ' ')}). Fallback shown: {t.answer}</p>}
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={(e) => void send(e)}>
        <div className="input-group">
          <label htmlFor="conv-input" className="diag-label">Your message:</label>
          <textarea id="conv-input" className="message-textarea" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} disabled={sending} required />
        </div>
        <div className="form-footer" style={{ marginTop: '12px' }}>
          <span className="char-count">{text.length}/500 characters</span>
          <button type="submit" className="btn-primary" disabled={sending || !text.trim()} aria-busy={sending}>{sending ? <><span className="spinner" aria-hidden="true" /><span>Looking it up…</span></> : 'Send →'}</button>
          {sending && <button type="button" className="btn-sm" onClick={() => flight.current?.abort()}>Cancel</button>}
        </div>
      </form>
      {last?.reply && (
        <div className="result-card" role="region" aria-label="Latest turn details">
          <ToolSteps steps={last.reply.steps} heading="Tools the server ran for this turn" />
          <p className="muted">{contextLine(last.reply)}</p>
        </div>
      )}
      {last?.failure && (
        <div className="error-card chat-failure" role="alert">
          <div>
            <div className="error-title">The assistant could not answer</div>
            <div className="error-msg">{last.failure.message}{last.failure.detail?.retryAfterSec ? ` Try again in about ${last.failure.detail.retryAfterSec} seconds.` : ''}</div>
            {last.failure.detail && last.failure.detail.steps.length > 0 && <ToolSteps steps={last.failure.detail.steps} heading="Tools that ran before it stopped" />}
          </div>
        </div>
      )}
    </div>
  );
};

const contextLine = (r: ConversationReply): string => {
  const { turnsSent, turnsDropped } = r.context;
  const sent = `The model was given ${turnsSent} earlier ${turnsSent === 1 ? 'turn' : 'turns'} of this conversation.`;
  return turnsDropped > 0 ? `${sent} ${turnsDropped} older ${turnsDropped === 1 ? 'turn was' : 'turns were'} left out to stay within the history budget.` : sent;
};

/** The one saved preference. It is stored on the server, applied by the server when it shows a menu, and removable at any time. */
const Preference: React.FC<{ token: string; onUnauthorized: () => void }> = ({ token, onUnauthorized }) => {
  const { state, reload, update } = useLoad((signal) => apiClient.prefs(token, signal), true, (s) => { if (s === 401) onUnauthorized(); });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; ctl.current = new AbortController(); return () => { alive.current = false; ctl.current?.abort(); }; }, []);
  if (state.status === 'loading') return <p role="status" className="muted">Loading your saved preference…</p>;
  if (state.status === 'error') return <div className="error-card" role="alert"><div><div className="error-title">Could not load your preference</div><div className="error-msg">{state.message}</div></div><button type="button" className="btn-sm" onClick={reload}>Retry</button></div>;
  const on = state.data.diet === 'vegetarian';
  const toggle = async () => {
    setSaving(true); setError(null);
    try {
      if (on) { await apiClient.clearDiet(token, ctl.current?.signal); if (alive.current) update(() => ({})); }
      else { const r = await apiClient.setVegetarian(token, ctl.current?.signal); if (alive.current) update(() => r.data); }
    } catch (err) {
      if (!alive.current || isCancelled(err)) return;
      if (status401(err)) { onUnauthorized(); return; }
      setError(say(err));
    } finally { if (alive.current) setSaving(false); }
  };
  return (
    <div className="preference">
      <label className="pref-label">
        <input type="checkbox" checked={on} disabled={saving} onChange={() => void toggle()} />
        <span>Show only vegetarian dishes when the assistant reads a menu</span>
      </label>
      <p className="muted">Saved on the server only because you chose it. {on ? 'It is on: menus the assistant reads are filtered by the server, and the answer says so.' : 'It is off.'} Untick it to delete it.</p>
      {error && <p role="alert" className="notice notice-error">{error}</p>}
    </div>
  );
};
