// A fake payment service provider (PSP). It stands in for a real gateway so the
// series can show idempotency, declines and unknown outcomes without real money.
// State is in memory on purpose: restarting the process is a clean slate.
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

export type Behavior = 'succeed' | 'decline' | 'timeout' | 'error';

type Charge = { id: string; amount: number; currency: string; reference: string; status: 'succeeded' | 'declined'; refunded: number };
type Refund = { id: string; chargeId: string; amount: number; status: 'succeeded' | 'declined' };
type Stored = { fingerprint: string; statusCode: number; body: unknown };

const chargeBody = z.object({ amount: z.number().int().positive(), currency: z.literal('INR'), reference: z.string().min(1) });
const refundBody = z.object({ chargeId: z.string().min(1), amount: z.number().int().positive() });
const leversBody = z.object({ charges: z.enum(['succeed', 'decline', 'timeout', 'error']).optional(), refunds: z.enum(['succeed', 'decline', 'timeout', 'error']).optional(), timeoutMs: z.number().int().positive().optional() });

export function buildFakePsp(opts: { timeoutMs?: number } = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const charges = new Map<string, Charge>();
  const refunds = new Map<string, Refund>();
  // Idempotency records, keyed per operation type so a charge key can't replay a refund.
  const idem = new Map<string, Stored>();
  const inFlight = new Set<string>();
  const levers: { charges: Behavior; refunds: Behavior; timeoutMs: number } = { charges: 'succeed', refunds: 'succeed', timeoutMs: opts.timeoutMs ?? 5000 };

  const fingerprint = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

  // Shared idempotent-write wrapper: replay a stored result, reject key reuse with a
  // different body, and reject a concurrent request with the same key.
  async function idempotent(kind: string, key: string | undefined, body: unknown, reply: any, run: () => Promise<{ statusCode: number; body: unknown; timeout?: true } | 'error'>) {
    if (!key) return reply.code(400).send({ error: 'idempotency_key_required' });
    const k = `${kind}:${key}`;
    const fp = fingerprint(body);
    if (inFlight.has(k)) return reply.code(409).send({ error: 'request_in_progress' });
    const prior = idem.get(k);
    if (prior) {
      if (prior.fingerprint !== fp) return reply.code(422).send({ error: 'idempotency_key_mismatch' });
      return reply.code(prior.statusCode).header('idempotent-replayed', 'true').send(prior.body);
    }
    inFlight.add(k);
    try {
      const result = await run();
      if (result === 'error') return reply.code(500).send({ error: 'provider_error' }); // nothing recorded
      idem.set(k, { fingerprint: fp, statusCode: result.statusCode, body: result.body });
      if (result.timeout) {
        // The provider DID apply the operation, but its answer never arrives: the client
        // sees a timeout and must look the outcome up. This is the "unknown outcome" case.
        await new Promise((r) => setTimeout(r, levers.timeoutMs));
        return reply.code(504).send({ error: 'gateway_timeout' });
      }
      return reply.code(result.statusCode).send(result.body);
    } finally {
      inFlight.delete(k);
    }
  }

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/v1/charges', async (req, reply) => {
    const parsed = chargeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const key = req.headers['idempotency-key'] as string | undefined;
    return idempotent('charge', key, parsed.data, reply, async () => {
      const b = levers.charges;
      if (b === 'error') return 'error';
      const charge: Charge = { id: `ch_${randomUUID()}`, ...parsed.data, status: b === 'decline' ? 'declined' : 'succeeded', refunded: 0 };
      charges.set(charge.id, charge);
      const result = { statusCode: charge.status === 'declined' ? 402 : 201, body: { ...charge, idempotencyKey: key } };
      return b === 'timeout' ? { ...result, timeout: true as const } : result;
    });
  });

  app.get('/v1/charges', async (req, reply) => {
    const key = (req.query as Record<string, string>).idempotency_key;
    const prior = key ? idem.get(`charge:${key}`) : undefined;
    return prior ? reply.code(200).send(prior.body) : reply.code(404).send({ error: 'not_found' });
  });

  app.post('/v1/refunds', async (req, reply) => {
    const parsed = refundBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const key = req.headers['idempotency-key'] as string | undefined;
    return idempotent('refund', key, parsed.data, reply, async () => {
      const charge = charges.get(parsed.data.chargeId);
      if (!charge || charge.status !== 'succeeded') return { statusCode: 404, body: { error: 'charge_not_found' } };
      if (charge.refunded + parsed.data.amount > charge.amount) return { statusCode: 422, body: { error: 'amount_exceeds_refundable' } };
      const b = levers.refunds;
      if (b === 'error') return 'error';
      const refund: Refund = { id: `re_${randomUUID()}`, ...parsed.data, status: b === 'decline' ? 'declined' : 'succeeded' };
      if (refund.status === 'succeeded') charge.refunded += refund.amount;
      refunds.set(refund.id, refund);
      const result = { statusCode: refund.status === 'declined' ? 402 : 201, body: { ...refund, idempotencyKey: key } };
      return b === 'timeout' ? { ...result, timeout: true as const } : result;
    });
  });

  app.get('/v1/refunds', async (req, reply) => {
    const key = (req.query as Record<string, string>).idempotency_key;
    const prior = key ? idem.get(`refund:${key}`) : undefined;
    return prior ? reply.code(200).send(prior.body) : reply.code(404).send({ error: 'not_found' });
  });

  // Test and demo control. A real provider has no such endpoint.
  app.post('/__levers', async (req, reply) => {
    const parsed = leversBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    Object.assign(levers, Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)));
    return levers;
  });

  return app;
}
