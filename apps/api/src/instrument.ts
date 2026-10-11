// Loaded with `--import` before the app, so http, pg and fetch are patched first.
// Tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (tests stay unchanged).
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'tadka-api' }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation(), new UndiciInstrumentation()],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
