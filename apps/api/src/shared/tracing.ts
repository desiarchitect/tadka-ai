import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('tadka-api');

// Wraps a service method in a span. Without an OTLP endpoint this is a no-op tracer.
// `fn` receives the span, so it can add an attribute only once it is safe to (see OrdersService: an order id is recorded only after
// the caller was found to own that order, never the id a caller merely asked for).
export function inSpan<T>(name: string, attrs: Record<string, string | number>, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
