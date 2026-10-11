import { describe, expect, it, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFakePsp } from '../src/app.js';

let psp: FastifyInstance;
beforeEach(() => { psp = buildFakePsp({ timeoutMs: 50 }); });

const charge = (key: string | undefined, body: object = { amount: 59800, currency: 'INR', reference: 'order-1' }) =>
  psp.inject({ method: 'POST', url: '/v1/charges', payload: body, headers: key ? { 'idempotency-key': key } : {} });

describe('fake PSP idempotency', () => {
  it('requires an idempotency key', async () => {
    expect((await charge(undefined)).statusCode).toBe(400);
  });

  it('replays the same result for the same key and body', async () => {
    const a = await charge('k1');
    const b = await charge('k1');
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers['idempotent-replayed']).toBe('true');
  });

  it('rejects the same key with a different body', async () => {
    await charge('k1');
    const b = await charge('k1', { amount: 1, currency: 'INR', reference: 'order-1' });
    expect(b.statusCode).toBe(422);
  });

  it('rejects a concurrent request with the same key', async () => {
    await psp.inject({ method: 'POST', url: '/__levers', payload: { charges: 'timeout' } });
    const [a, b] = await Promise.all([charge('k1'), charge('k1')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([409, 504]);
  });

  it('records a timed-out charge so a lookup finds the real outcome', async () => {
    await psp.inject({ method: 'POST', url: '/__levers', payload: { charges: 'timeout' } });
    expect((await charge('k1')).statusCode).toBe(504);
    const lookup = await psp.inject({ method: 'GET', url: '/v1/charges?idempotency_key=k1' });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().status).toBe('succeeded');
  });

  it('records nothing on a provider error, so a retry with the same key can succeed', async () => {
    await psp.inject({ method: 'POST', url: '/__levers', payload: { charges: 'error' } });
    expect((await charge('k1')).statusCode).toBe(500);
    await psp.inject({ method: 'POST', url: '/__levers', payload: { charges: 'succeed' } });
    expect((await charge('k1')).statusCode).toBe(201);
  });

  it('records a decline as a final result for that key', async () => {
    await psp.inject({ method: 'POST', url: '/__levers', payload: { charges: 'decline' } });
    expect((await charge('k1')).statusCode).toBe(402);
    await psp.inject({ method: 'POST', url: '/__levers', payload: { charges: 'succeed' } });
    expect((await charge('k1')).statusCode).toBe(402);
  });

  it('never refunds more than the charge amount', async () => {
    const ch = (await charge('k1')).json();
    const refund = (key: string, amount: number) =>
      psp.inject({ method: 'POST', url: '/v1/refunds', payload: { chargeId: ch.id, amount }, headers: { 'idempotency-key': key } });
    expect((await refund('r1', 40000)).statusCode).toBe(201);
    expect((await refund('r1', 40000)).statusCode).toBe(201); // replay, not a second refund
    expect((await refund('r2', 20000)).statusCode).toBe(422);
    expect((await refund('r3', 19800)).statusCode).toBe(201);
  });
});
