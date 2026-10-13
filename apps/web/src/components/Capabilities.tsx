import React from 'react';
import { ASSISTANT_CAPABILITIES } from '../episode.js';

export const Capabilities: React.FC = () => (
  <details className="capabilities">
    <summary>What can the assistant do in this build?</summary>
    <ul className="plain-list">
      {ASSISTANT_CAPABILITIES.map((c) => (
        <li key={c.episode}>
          <strong>{c.episode} · {c.name}</strong>{' '}
          <span className={`status ${c.available ? 'status-Confirmed' : 'status-off'}`}>{c.available ? 'Available' : 'Not in this build'}</span>
          <div className="muted">{c.what}</div>
        </li>
      ))}
    </ul>
    <p className="muted">Your orders and the restaurant menus on this page come straight from the Tadka API. They are not produced by the assistant.</p>
  </details>
);
