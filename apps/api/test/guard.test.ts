// The shared guard for model-spending routes, on a bare Fastify app (no database, no model).
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_TIMEOUT_MS, DEFAULT_RATE_LIMIT_PER_MIN, perUserLimit, providerSignal, registerAssistLimiter, requireCustomer } from '../src/assist/guard.js';
import { UnauthorizedError } from '../src/shared/errors.js';
import type { Principal } from '../src/shared/principal.js';

// A stand-in for token verification: "Bearer <role>:<userId>".
const principal = async (req: FastifyRequest): Promise<Principal> => {
  const m = /^Bearer (\w+):(\w+)$/.exec(req.headers.authorization ?? '');
  if (!m) throw new UnauthorizedError('missing_token');
  return { userId: m[2]!, role: m[1] as Principal['role'] };
};

async function build(max: number) {
  const app = Fastify();
  app.setErrorHandler((err: Error & { status?: number }, _req, reply) => reply.code(err.status ?? 500).send({ error: err.message }));
  app.register(async (scope) => {
    await registerAssistLimiter(scope);
    scope.post('/a', { preHandler: requireCustomer(principal), config: perUserLimit(max) }, async (req) => ({ route: 'a', user: req.principal!.userId }));
    scope.post('/b', { preHandler: requireCustomer(principal, 'customers_only'), config: perUserLimit(max) }, async (req) => ({ route: 'b', user: req.principal!.userId }));
    scope.post('/open', async () => ({ route: 'open' })); // no config: not limited
  });
  await app.ready();
  return app;
}
const call = (app: Awaited<ReturnType<typeof build>>, url: string, auth?: string) => app.inject({ method: 'POST', url, headers: auth ? { authorization: `Bearer ${auth}` } : {}, payload: {} });

describe('the shared assist guard', () => {
  it('defaults: 10 per minute and a 15 s provider timeout', () => {
    expect(DEFAULT_RATE_LIMIT_PER_MIN).toBe(10);
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(15_000);
  });

  it('unauthenticated is 401 and a non-customer is 403 with the route\'s own code, both before any quota is used', async () => {
    const app = await build(2);
    for (let i = 0; i < 5; i++) { await call(app, '/a'); await call(app, '/a', 'Admin:x'); }
    expect((await call(app, '/a')).statusCode).toBe(401);
    expect(((await call(app, '/a', 'Admin:x')).json())).toEqual({ error: 'forbidden_role' });
    expect(((await call(app, '/b', 'Admin:x')).json())).toEqual({ error: 'customers_only' });
    expect((await call(app, '/a', 'Customer:u1')).statusCode).toBe(200);
    expect((await call(app, '/a', 'Customer:u1')).statusCode).toBe(200);
    expect((await call(app, '/a', 'Customer:u1')).statusCode).toBe(429);
    await app.close();
  });

  it('the limit is per verified user', async () => {
    const app = await build(1);
    expect((await call(app, '/a', 'Customer:u1')).statusCode).toBe(200);
    expect((await call(app, '/a', 'Customer:u1')).statusCode).toBe(429);
    expect((await call(app, '/a', 'Customer:u2')).statusCode).toBe(200);
    await app.close();
  });

  it('each route has its own quota per user: using up one route does not use up another', async () => {
    const app = await build(1);
    expect((await call(app, '/a', 'Customer:u1')).statusCode).toBe(200);
    expect((await call(app, '/a', 'Customer:u1')).statusCode).toBe(429);
    expect((await call(app, '/b', 'Customer:u1')).statusCode).toBe(200);
    expect((await call(app, '/b', 'Customer:u1')).statusCode).toBe(429);
    await app.close();
  });

  it('a route without the limiter config is not limited', async () => {
    const app = await build(1);
    for (let i = 0; i < 5; i++) expect((await call(app, '/open')).statusCode).toBe(200);
    await app.close();
  });

  it('429 carries Retry-After in seconds', async () => {
    const app = await build(1);
    await call(app, '/a', 'Customer:u1');
    const r = await call(app, '/a', 'Customer:u1');
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('providerSignal aborts with a TimeoutError after the given time', async () => {
    const s = providerSignal(40);
    expect(s.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 90));
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).name).toBe('TimeoutError');
  });
});
