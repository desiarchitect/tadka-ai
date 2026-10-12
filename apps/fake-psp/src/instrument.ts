// Same pattern as the API: tracing only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'tadka-fake-psp' }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
  // main.ts runs the shutdown sequence and calls this last (see shutdown.ts). No signal handler here:
  // a bare SIGTERM handler stops Node from exiting.
  (globalThis as Record<symbol, unknown>)[Symbol.for('tadka.telemetry.stop')] = () => sdk.shutdown();
}
