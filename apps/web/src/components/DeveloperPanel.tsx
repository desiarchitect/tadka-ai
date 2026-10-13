import React, { useState } from 'react';
import type { ApiDiagnostics } from '../api/types.js';

interface DeveloperPanelProps {
  diagnostics: ApiDiagnostics | null;
}

export const DeveloperPanel: React.FC<DeveloperPanelProps> = ({ diagnostics }) => {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <aside className={`dev-panel-card ${isOpen ? 'open' : ''}`} aria-labelledby="dev-panel-heading">
      <button
        type="button"
        className="dev-toggle-header"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls="dev-panel-body"
      >
        <span className="dev-title" id="dev-panel-heading">
          <span aria-hidden="true">&#128295;</span>
          <span>Developer Demonstration Panel (Real Backend Telemetry)</span>
        </span>
        <span className="btn-sm dev-toggle-label" aria-hidden="true">
          {isOpen ? 'Collapse ▲' : 'Expand Diagnostics ▼'}
        </span>
      </button>

      {isOpen && (
        <div className="dev-body" id="dev-panel-body">
          {!diagnostics ? (
            <p className="diag-value na">
              No API request dispatched yet. Submit an inquiry above to observe live backend telemetry.
            </p>
          ) : (
            <>
              <div className="diag-grid">
                {/* HTTP Status & Outcome */}
                <div className="diag-item">
                  <span className="diag-label">HTTP Status &amp; Outcome</span>
                  <span
                    className={`diag-value ${
                      diagnostics.outcome === 'success' ? 'success' : 'error'
                    }`}
                  >
                    {diagnostics.httpStatus > 0
                      ? `${diagnostics.httpStatus} ${diagnostics.statusText}`
                      : 'Network / Connection Failure'}
                  </span>
                </div>

                {/* Authentication Status */}
                <div className="diag-item">
                  <span className="diag-label">Authenticated by Backend</span>
                  <span
                    className={`diag-value ${
                      diagnostics.authenticated ? 'success' : 'error'
                    }`}
                  >
                    {diagnostics.authenticated
                      ? `Yes (${diagnostics.userRole ?? 'Customer'})`
                      : 'No (Unauthenticated)'}
                  </span>
                </div>

                {/* Roundtrip Latency */}
                <div className="diag-item">
                  <span className="diag-label">Roundtrip Latency</span>
                  <span className="diag-value">{diagnostics.durationMs} ms (Client Measured)</span>
                </div>

                {/* Model Metadata */}
                <div className="diag-item">
                  <span className="diag-label">Served LLM Model</span>
                  <span className="diag-value">
                    {diagnostics.modelId ? (
                      <>
                        {diagnostics.modelId}
                        {diagnostics.simulated ? ' (simulated)' : ''}
                      </>
                    ) : (
                      <span className="na">Unavailable on failed request</span>
                    )}
                  </span>
                </div>

                {/* Token Usage */}
                <div className="diag-item">
                  <span className="diag-label">Token Consumption</span>
                  <span className="diag-value">
                    {diagnostics.tokenUsage ? (
                      `${diagnostics.tokenUsage.inputTokens ?? 0} in / ${diagnostics.tokenUsage.outputTokens ?? 0} out`
                    ) : (
                      <span className="na">None / Not reported</span>
                    )}
                  </span>
                </div>

                {/* Fastify Request ID */}
                <div className="diag-item">
                  <span className="diag-label">Request ID (Fastify)</span>
                  <span className="diag-value">
                    {diagnostics.requestId ? (
                      diagnostics.requestId
                    ) : (
                      <span className="na">Not emitted</span>
                    )}
                  </span>
                </div>

                {/* OpenTelemetry Trace ID */}
                <div className="diag-item diag-wide">
                  <span className="diag-label">OpenTelemetry Trace ID</span>
                  <span className="diag-value">
                    {diagnostics.traceId ? (
                      <strong>{diagnostics.traceId}</strong>
                    ) : (
                      <span className="na">
                        Not available (OTel endpoint disabled or span not exported)
                      </span>
                    )}
                  </span>
                </div>

                {/* Safe Error Code */}
                {diagnostics.outcome === 'error' && (
                  <div className="diag-item diag-wide">
                    <span className="diag-label">Backend Error Code</span>
                    <span className="diag-value error">
                      {diagnostics.errorCode ?? 'unknown_error'}
                    </span>
                  </div>
                )}
              </div>

              {diagnostics.traceId && (
                <div className="jaeger-hint">
                  <strong>Jaeger Observability:</strong> View the distributed trace for this request in Jaeger UI at{' '}
                  <code>http://localhost:16686</code> (service: <code>tadka-api</code>, search Trace ID:{' '}
                  <code>{diagnostics.traceId}</code>).
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
};
