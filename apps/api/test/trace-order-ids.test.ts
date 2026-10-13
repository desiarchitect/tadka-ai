// O-2: a trace records an order id only for an order the caller owns. The id a caller merely ASKED for (someone else's order, or an
// invented one) never reaches a span attribute, and the two cases leave the same trace. A fake tracer stands in for the exporter.
import { eq } from 'drizzle-orm';
import { trace } from '@opentelemetry/api';
import { beforeAll, describe, expect, it } from 'vitest';
import { orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

type Rec = { name: string; attrs: Record<string, unknown> };
const spans: Rec[] = [];
const fakeSpan = (rec: Rec) => ({
  setAttribute: (k: string, v: unknown) => { rec.attrs[k] = v; return fakeSpan(rec); }, setAttributes: () => fakeSpan(rec),
  recordException: () => undefined, setStatus: () => fakeSpan(rec), end: () => undefined, isRecording: () => true,
  spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }), updateName: () => fakeSpan(rec), addEvent: () => fakeSpan(rec), addLink: () => fakeSpan(rec), addLinks: () => fakeSpan(rec),
});
const fakeTracer = {
  startActiveSpan: (name: string, opts: { attributes?: Record<string, unknown> }, fn: (s: unknown) => unknown) => {
    const rec: Rec = { name, attrs: { ...(opts?.attributes ?? {}) } }; spans.push(rec); return fn(fakeSpan(rec));
  },
  startSpan: (name: string) => fakeSpan({ name, attrs: {} }),
};
trace.setGlobalTracerProvider({ getTracer: () => fakeTracer } as never);

let stack: Awaited<ReturnType<typeof startStack>>;
let rahul: string; let amanOrder: string;
beforeAll(async () => {
  stack = await startStack();
  rahul = (await stack.login('rahul@tadka.test')).accessToken;
  amanOrder = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman)))[0]!.id;
});
const get = (id: string) => stack.app.inject({ method: 'GET', url: `/orders/${id}`, headers: { authorization: `Bearer ${rahul}` } });
const getSpans = () => spans.filter((s) => s.name === 'orders.get');

describe('order ids in spans', () => {
  it('an order the caller owns is recorded, after the ownership check', async () => {
    spans.length = 0;
    expect((await get(IDS.rahulPlacedOrder)).statusCode).toBe(200);
    expect(getSpans().map((s) => s.attrs['tadka.order_id'])).toEqual([IDS.rahulPlacedOrder]);
  });

  it("someone else's order and an invented id: 404, no order id on any span, and the two traces look the same", async () => {
    spans.length = 0;
    const invented = '99999999-9999-4999-8999-999999999999';
    expect((await get(amanOrder)).statusCode).toBe(404);
    const afterForeign = JSON.stringify(spans);
    spans.length = 0;
    expect((await get(invented)).statusCode).toBe(404);
    const afterInvented = JSON.stringify(spans);
    expect(afterForeign).not.toContain(amanOrder);
    expect(afterInvented).not.toContain(invented);
    expect(afterForeign.replace(amanOrder, 'X')).toBe(afterInvented.replace(invented, 'X'));
    expect(getSpans().every((s) => !('tadka.order_id' in s.attrs))).toBe(true);
  });

  it('paying: the foreign id is not recorded either', async () => {
    spans.length = 0;
    const res = await stack.app.inject({ method: 'POST', url: `/orders/${amanOrder}/pay`, headers: { authorization: `Bearer ${rahul}` } });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(spans)).not.toContain(amanOrder);
  });
});
