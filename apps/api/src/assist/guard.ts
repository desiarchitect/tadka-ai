// What every route that spends model tokens shares: who may call it, how often, and how long it may wait for the
// provider. Written once so the routes cannot drift apart (the review found a second route without any of these).
//
//   registerAssistLimiter(scope)   loads the limiter into `scope`. It must run, and be awaited, BEFORE the routes
//                                  of that scope are declared: the plugin attaches itself through an onRoute hook.
//   requireCustomer(principal)     a preHandler: verified token, Customer role, identity put on req.principal.
//   perUserLimit(max)              the route's `config`: `max` requests a minute per verified user, keyed on
//                                  req.principal.userId. The limiter's own hook runs after requireCustomer, so
//                                  requests rejected for authentication or role never use up anyone's quota.
//   providerSignal(ms)             the abort signal for one provider call. Passed to the AI SDK, it reaches fetch.
//
// The limiter is in process memory: it resets on restart and is not shared between instances. It is abuse
// protection, not a spending cap.
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';

declare module 'fastify' {
  interface FastifyRequest { principal?: Principal }
}

export const DEFAULT_RATE_LIMIT_PER_MIN = 10;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export async function registerAssistLimiter(scope: FastifyInstance) {
  await scope.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    errorResponseBuilder: (_req, ctx) => Object.assign(new Error('rate_limited'), { status: 429, retryAfterSec: Math.ceil(ctx.ttl / 1000) }),
  });
}

/** `forbiddenCode` is the error code an authenticated non-customer gets with 403. */
export const requireCustomer = (principal: (req: FastifyRequest) => Promise<Principal>, forbiddenCode = 'forbidden_role') =>
  async (req: FastifyRequest) => {
    const p = await principal(req);
    if (p.role !== 'Customer') throw new ForbiddenError(forbiddenCode);
    req.principal = p;
  };

export const perUserLimit = (maxPerMinute: number = DEFAULT_RATE_LIMIT_PER_MIN) => ({
  rateLimit: { max: maxPerMinute, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.principal!.userId },
});

export const providerSignal = (timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS) => AbortSignal.timeout(timeoutMs);
