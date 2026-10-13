import React, { useState } from 'react';
import type { ChatFailure, ChatResponse } from '../api/types.js';
import { ToolSteps as Steps } from './ToolSteps.js';

type Props = {
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
  isLoading: boolean;
  /** true when THIS card started the request in flight (only then it shows the spinner and Cancel). */
  activeRequest?: boolean;
  result: ChatResponse | null;
  /** A failed turn: the page's own wording for the code, plus what the server said (validated). */
  failure: { message: string; detail: ChatFailure | null } | null;
  unavailableReason?: string | null;
};

const SAMPLES = [
  { label: 'Where is my food?', text: 'Where is my food?' },
  { label: 'My latest order', text: 'What is the status of my latest order?' },
  { label: 'All my orders', text: 'Show me my recent orders.' },
  { label: 'Menu of my last restaurant', text: 'What is on the menu at the restaurant of my latest order?' },
];

/**
 * EP-2: a question answered with tools. Everything here is what POST /assist/chat returned. The page does not authorize anything:
 * the server checks the token, the role and the ownership of every order the model asks about, and runs only read-only tools.
 * The page shows (1) the answer, which the server writes from the tool results (the model writes none of it), and (2) which tools
 * ran and how each ended. It does not show the tools' arguments or results, because the API does not send them.
 * A failed turn is shown as a failure, never as an answer, even though the server also sends a fixed, safe fallback sentence.
 */
export const ChatCard: React.FC<Props> = ({ onSubmit, onCancel, isLoading, activeRequest = true, result, failure, unavailableReason = null }) => {
  const working = isLoading && activeRequest;
  const [text, setText] = useState(SAMPLES[0]!.text);
  const locked = isLoading || Boolean(unavailableReason);
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!locked && text.trim()) void onSubmit(text.trim()); };

  return (
    <section className="customer-card" aria-labelledby="chat-heading">
      <h2 id="chat-heading" className="section-title"><span aria-hidden="true">&#128269;</span> Ask about your orders <span className="status status-Confirmed">EP-2</span></h2>
      <p className="muted"><strong>Uses tools.</strong> The assistant looks up your orders and menus through read-only tools that the server validates and authorizes for your account. The model never chooses whose data it reads.</p>
      <div className="preset-chips" aria-label="Sample questions">
        {SAMPLES.map((x) => <button key={x.label} type="button" className="chip" disabled={locked} onClick={() => setText(x.text)}>{x.label}</button>)}
      </div>
      <form onSubmit={submit}>
        <div className="input-group">
          <label htmlFor="chat-input" className="diag-label">Your question:</label>
          <textarea id="chat-input" className="message-textarea" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} disabled={locked} required />
        </div>
        <div className="form-footer" style={{ marginTop: '12px' }}>
          <span className="char-count">{text.length}/500 characters</span>
          <button type="submit" className="btn-primary" disabled={locked || !text.trim()} aria-busy={working}>
            {working ? <><span className="spinner" aria-hidden="true" /><span>Looking it up…</span></> : 'Ask →'}
          </button>
          {working && <button type="button" className="btn-sm" onClick={onCancel}>Cancel</button>}
        </div>
      </form>
      {unavailableReason && <p className="diag-value na" role="status">{unavailableReason}</p>}
      {failure && <ChatFailureView failure={failure} />}
      {result && (
        <div className="result-card" role="region" aria-label="Assistant answer">
          <div>
            <span className="diag-label">Answer (written by the server from the tool results)</span>
            <div className="summary-box chat-answer">{result.answer}</div>
          </div>
          <Steps steps={result.steps} heading="Tools the server ran for you" />
          {result.stopReason !== 'answered' && <p className="muted">Ended as: {result.stopReason.replace(/_/g, ' ')}</p>}
        </div>
      )}
    </section>
  );
};

const ChatFailureView: React.FC<{ failure: NonNullable<Props['failure']> }> = ({ failure }) => (
  <div className="error-card chat-failure" role="alert">
    <div>
      <div className="error-title">The assistant could not answer</div>
      <div className="error-msg">{failure.message}{failure.detail?.retryAfterSec ? ` Try again in about ${failure.detail.retryAfterSec} seconds.` : ''}</div>
      {failure.detail && failure.detail.steps.length > 0 && <Steps steps={failure.detail.steps} heading="Tools that ran before it stopped" />}
      {failure.detail?.answer && <p className="muted">Fallback shown by the server (not an answer): {failure.detail.answer}</p>}
    </div>
  </div>
);
