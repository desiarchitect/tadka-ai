import React from 'react';
import type { ChatStep } from '../api/types.js';

const TOOL_LABEL: Record<string, string> = { get_my_orders: 'Read your recent orders', get_order: 'Read one order', get_restaurant_menu: 'Read a restaurant menu' };
const STATUS_LABEL: Record<ChatStep['status'], string> = {
  ok: 'ok',
  not_found: 'not found',
  invalid_args: 'rejected (invalid arguments)',
  failed: 'failed',
};

/** Which tools the server ran for a question, and how each ended. The API sends no tool arguments or results, so none are shown. */
export const ToolSteps: React.FC<{ steps: ChatStep[]; heading: string }> = ({ steps, heading }) => (
  <div>
    <span className="diag-label">{heading}</span>
    {steps.length === 0 ? (
      <p className="muted">No tool was run.</p>
    ) : (
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={i}>
            <span>{TOOL_LABEL[s.tool] ?? 'Unknown tool'} <code className="tool-name">{s.tool}</code></span>
            <span className={`status status-tool-${s.status}`}>{STATUS_LABEL[s.status]}</span>
          </li>
        ))}
      </ol>
    )}
  </div>
);
