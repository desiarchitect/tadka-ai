import React, { useState } from 'react';
import type { IntentResponse } from '../api/types.js';
import { shortId } from '../lib/format.js';

type Props = {
  onSubmit: (text: string) => Promise<void>;
  isLoading: boolean;
  activeRequest?: boolean;
  result: IntentResponse | null;
  error: string | null;
  /** Why the form is off (not signed in, no API address). */
  unavailableReason?: string | null;
};

const SAMPLES = [
  { label: 'Where is my food?', text: 'Where is my food? It has been a while.' },
  { label: 'Cancel (negated)', text: 'Cancel mat karna, bas status batao' },
  { label: 'Refund', text: 'My biryani was cold, I want my money back.' },
  { label: 'Menu question', text: 'Do you have anything vegetarian and not spicy?' },
];

const say = (s: string) => s.replace(/_/g, ' ');

/**
 * EP-1: structured intent classification. This card shows exactly what POST /assist/intent returned and keeps two things apart:
 * the CLASSIFICATION (one label, from a model or from keyword rules) and the NEXT STEP, which server code chose from that label.
 * No confidence score is shown because the API sends none.
 */
export const IntentCard: React.FC<Props> = ({ onSubmit, isLoading, activeRequest = true, result, error, unavailableReason = null }) => {
  const [text, setText] = useState(SAMPLES[0]!.text);
  const locked = isLoading || Boolean(unavailableReason);
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!locked && text.trim()) void onSubmit(text.trim()); };

  return (
    <section className="customer-card" aria-labelledby="intent-heading">
      <h2 id="intent-heading" className="section-title"><span aria-hidden="true">&#127991;&#65039;</span> Intent classification <span className="status status-Confirmed">EP-1</span></h2>
      <p className="muted"><strong>Classification only.</strong> The classifier returns one label for your message. It does not read your orders. What happens next is chosen by server code from that label.</p>
      <div className="preset-chips" aria-label="Sample messages for intent classification">
        {SAMPLES.map((x) => <button key={x.label} type="button" className="chip" disabled={locked} onClick={() => setText(x.text)}>{x.label}</button>)}
      </div>
      <form onSubmit={submit}>
        <div className="input-group">
          <label htmlFor="intent-input" className="diag-label">Message to classify:</label>
          <textarea id="intent-input" className="message-textarea" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} disabled={locked} required />
        </div>
        <div className="form-footer" style={{ marginTop: '12px' }}>
          <span className="char-count">{text.length}/500 characters</span>
          <button type="submit" className="btn-primary" disabled={locked || !text.trim()}>{isLoading && activeRequest ? 'Working…' : 'Classify intent →'}</button>
        </div>
      </form>
      {unavailableReason && <p className="diag-value na" role="status">{unavailableReason}</p>}
      {error && <div className="error-card" role="alert"><div><div className="error-title">Request Unsuccessful</div><div className="error-msg">{error}</div></div></div>}
      {result && <IntentResult r={result} />}
    </section>
  );
};

const IntentResult: React.FC<{ r: IntentResponse }> = ({ r }) => (
  <div className="result-card" role="region" aria-label="Intent classification result">
    <div className="badge-row">
      {r.simulated && <span className="badge badge-simulated" title="Demo mode: no real model produced this">SIMULATED</span>}
      <span className="badge badge-lang">{r.classifier === 'llm' ? 'Classifier: language model' : 'Classifier: keyword rules (no model called)'}</span>
    </div>
    <div>
      <span className="diag-label">1. Classification</span>
      <div className="summary-box">
        {r.outcome === 'ok' && r.intent ? <>Intent: <strong>{say(r.intent)}</strong></> : <>No intent was produced (outcome: {say(r.outcome)}).</>}
      </div>
    </div>
    <div>
      <span className="diag-label">2. Next step (chosen by server code, not by the model)</span>
      <div className="summary-box">
        <NextStepView next={r.next} />
      </div>
    </div>
  </div>
);

const NextStepView: React.FC<{ next: IntentResponse['next'] }> = ({ next }) => {
  switch (next.action) {
    case 'order_status':
      return <>Looked up by the server for your account: order <strong>{shortId(next.order.orderId)}</strong> is <strong>{next.order.status}</strong>.</>;
    case 'choose_order':
      return (
        <>
          <p>{next.message}</p>
          <ul className="plain-list">{next.orders.map((o) => <li key={o.orderId}>Order {shortId(o.orderId)}: {o.status}</li>)}</ul>
        </>
      );
    default:
      return <>{next.message}</>;
  }
};
