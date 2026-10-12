import React, { useState } from 'react';
import type { TriageResponse } from '../api/types.js';

interface CustomerViewProps {
  onSubmit: (message: string) => Promise<void>;
  isLoading: boolean;
  result: TriageResponse | null;
  error: string | null;
  onReset: () => void;
}

const PRESET_MESSAGES = [
  {
    label: 'Late Order (Hinglish)',
    text: 'Mera order 40 minute se late hai, Paneer Butter Masala abhi tak nahi aaya. Kab aayega?',
  },
  {
    label: 'Cold Food Refund (English)',
    text: 'My biryani arrived completely cold, I want an immediate refund.',
  },
  {
    label: 'Menu Inquiry (English)',
    text: 'Can you recommend non-spicy vegetarian curries for tonight?',
  },
];

export const CustomerView: React.FC<CustomerViewProps> = ({
  onSubmit,
  isLoading,
  result,
  error,
  onReset,
}) => {
  const [message, setMessage] = useState(PRESET_MESSAGES[0]?.text ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || isLoading) return;
    onSubmit(message.trim());
  };

  return (
    <section className="customer-card" aria-labelledby="assistant-heading">
      <h2 id="assistant-heading" className="section-title">
        <span aria-hidden="true">&#127858;</span> Customer Inquiry &amp; Support Assistant
      </h2>

      {/* Suggested prompts for easy demo recording */}
      <div className="preset-chips" aria-label="Suggested sample messages">
        <span className="diag-label" style={{ alignSelf: 'center' }}>
          Sample Prompts:
        </span>
        {PRESET_MESSAGES.map((preset, idx) => (
          <button
            key={idx}
            type="button"
            className="chip"
            onClick={() => setMessage(preset.text)}
            disabled={isLoading}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        <div className="input-group">
          <label htmlFor="message-input" className="diag-label">
            Message for Tadka Food Assistant:
          </label>
          <textarea
            id="message-input"
            className="message-textarea"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your question or issue in Hinglish, English, or Hindi..."
            maxLength={500}
            disabled={isLoading}
            rows={3}
            required
          />
        </div>

        <div className="form-footer" style={{ marginTop: '12px' }}>
          <span className="char-count">{message.length}/500 characters</span>
          <button
            type="submit"
            className="btn-primary"
            disabled={isLoading || !message.trim()}
          >
            {isLoading ? (
              <>
                <span className="spinner" aria-hidden="true" />
                <span>Analyzing Request...</span>
              </>
            ) : (
              <span>Submit to Assistant &rarr;</span>
            )}
          </button>
        </div>
      </form>

      {/* Error View */}
      {error && (
        <div className="error-card" role="alert">
          <span style={{ fontSize: '20px' }} aria-hidden="true">
            &#10060;
          </span>
          <div>
            <div className="error-title">Request Unsuccessful</div>
            <div className="error-msg">{error}</div>
          </div>
        </div>
      )}

      {/* Actual Backend Result View */}
      {result && (
        <div className="response-container">
          <div className="result-card" role="region" aria-label="Tadka Assistant Response">
            <div className="badge-row">
              <span className="badge badge-intent" title="Classified Intent">
                Intent: {result.output.intent.replace('_', ' ')}
              </span>
              <span className="badge badge-lang" title="Detected Language">
                Language: {result.output.language}
              </span>
              <span
                className={`badge ${
                  result.output.needsHuman ? 'badge-escalate-yes' : 'badge-escalate-no'
                }`}
                title="Human Escalation Recommendation"
              >
                Human Escalation: {result.output.needsHuman ? 'Required' : 'Not Required'}
              </span>
            </div>

            <div>
              <span className="diag-label">Structured Triage Summary:</span>
              <div className="summary-box">{result.output.summary}</div>
            </div>

            <div className="reset-row">
              <button
                type="button"
                className="btn-sm"
                onClick={onReset}
              >
                &#8634; Submit Another Inquiry
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
