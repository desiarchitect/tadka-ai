import { SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('tadka-api');

// Wraps a service method in a span. Without an OTLP endpoint this is a no-op tracer.
export function inSpan<T>(name: string, attrs: Record<string, string | number>, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
