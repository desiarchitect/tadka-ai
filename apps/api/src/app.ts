import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { AISDKError } from 'ai';
import { trace } from '@opentelemetry/api';
import type { ModelPort } from './llm/types.js';
import { z } from 'zod';
import { DEMO_MODEL_ID } from './assist/demo-model.js';
import { classifyProviderError, safeErrorFields } from './assist/errors.js';
import { triage } from './assist/triage.js';
import { verifyAccessToken, type SigningKeys } from './identity/access-tokens.js';
import { IdentityService } from './identity/service.js';
import type { LanguageModel } from 'ai';
import type { ProviderOptions } from './llm/types.js';
import { runTurn, type LoopConfig } from './assist/agent-loop.js';
import type { BudgetLedger } from './assist/budget.js';
import { rulesClassifier, type IntentClassifier } from './assist/classifiers.js';
import type { SecurityAudit } from './assist/tools/audit.js';
import { registerAssistRoutes } from './assist/routes.js';
import { OrdersService } from './orders/service.js';
import type { PaymentProvider } from './payments/provider.js';
import { PaymentsService } from './payments/service.js';
import { RestaurantsService } from './restaurants/service.js';
import type { Db } from './shared/db.js';
import { ForbiddenError, UnauthorizedError } from './shared/errors.js';
import type { Principal } from './shared/principal.js';

// `providerOptions` and `config.priceKey` come from the ModelHandle built in src/llm.
export type AssistantDeps = { model: LanguageModel; providerOptions: ProviderOptions; ledger: BudgetLedger; config: LoopConfig; audit: SecurityAudit };
export type AppDeps = {
  db: Db;
  keys: SigningKeys;
  provider: PaymentProvider;
  classify?: IntentClassifier;
  assistant?: AssistantDeps;
  model?: ModelPort;
  /** True when `model` is the simulated demo model. Every triage response then says `simulated: true`. */
  demo?: boolean;
  corsOrigins?: string[];
  /** Per-user limit for POST /assist/triage. Basic abuse protection, not a spending cap. */
  triageRateLimitPerMin?: number;
  /** Upper bound on one provider call. */
  triageTimeoutMs?: number;
  logger?: FastifyServerOptions['logger'];
};

declare module 'fastify' {
  interface FastifyRequest { principal?: Principal }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? (process.env.NODE_ENV !== 'test' && { level: 'info' }) });
  const identity = new IdentityService(deps.db, deps.keys);
  const restaurants = new RestaurantsService(deps.db);
  const payments = new PaymentsService(deps.db, deps.provider);
  const orders = new OrdersService(deps.db, payments);

  const allowedOrigins = deps.corsOrigins ?? [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ];
  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      // Not an error: the response just carries no CORS headers, so a browser will not let the page read it.
      // CORS is a browser rule, not authorization; the token and role checks decide who may call.
      cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: ['x-trace-id', 'x-request-id'],
  });

  app.addHook('onSend', async (req, reply) => {
    const span = trace.getActiveSpan();
    const traceId = span?.spanContext().traceId;
    if (traceId) reply.header('x-trace-id', traceId);
    reply.header('x-request-id', req.id);
  });

  // Map domain errors to HTTP. Anything without a status is a 500 with no details.
  // AI SDK errors carry a provider `statusCode`; it is never the status we answer with.
  app.setErrorHandler((err: Error & { status?: number; statusCode?: number; retryAfterSec?: number }, req, reply) => {
    const fromSdk = AISDKError.isInstance(err);
    const status = err.status ?? (!fromSdk && err.statusCode && err.statusCode < 500 ? err.statusCode : 500);
    const hidden = status >= 500 && !err.status;
    if (hidden) { if (fromSdk) req.log.error({ errorName: err.name }, 'unhandled AI SDK error'); else app.log.error(err); }
    if (err.retryAfterSec) reply.header('retry-after', String(err.retryAfterSec));
    reply.code(status).send({ error: hidden ? 'internal_error' : err.message });
  });

  const principal = async (req: FastifyRequest): Promise<Principal> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('missing_token');
    return verifyAccessToken(deps.keys, header.slice(7));
  };
  const idParam = z.object({ id: z.uuid() });
  const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw Object.assign(new Error('invalid_request'), { status: 400 });
    return r.data;
  };

  app.get('/health', async () => ({ status: 'ok' }));

  const login = z.object({ email: z.email(), password: z.string().min(1).max(200) });
  const refresh = z.object({ refreshToken: z.string().min(1).max(200) });
  app.post('/auth/login', async (req) => { const b = parse(login, req.body); return identity.login(b.email, b.password); });
  app.post('/auth/refresh', async (req) => identity.refresh(parse(refresh, req.body).refreshToken));
  app.post('/auth/logout', async (req, reply) => { await identity.logout(parse(refresh, req.body).refreshToken); return reply.code(204).send(); });

  app.get('/restaurants', async () => restaurants.list());
  app.get('/restaurants/:id/menu', async (req) => restaurants.menu(parse(idParam, req.params).id));

  app.get('/orders', async (req) => orders.list(await principal(req)));
  app.get('/orders/:id', async (req) => orders.get(await principal(req), parse(idParam, req.params).id));
  app.post('/orders/:id/pay', async (req) => orders.pay(await principal(req), parse(idParam, req.params).id));

  const a = deps.assistant;
  const chat = a && ((p: Principal, text: string) => runTurn({
    model: a.model, providerOptions: a.providerOptions, ledger: a.ledger, config: a.config,
    executor: { orders, restaurants, audit: a.audit, log: (line) => app.log.info(line) },
    log: (e) => app.log.warn(e),
  }, p, text));
  registerAssistRoutes(app, { orders, principal, parse, classify: deps.classify ?? rulesClassifier, chat });

  const triageBody = z.object({ message: z.string().trim().min(1).max(500) });
  // The caller's identity and role come from the verified token only, never from the request body.
  const requireCustomer = async (req: FastifyRequest) => {
    const p = await principal(req);
    if (p.role !== 'Customer') throw new ForbiddenError('forbidden_role');
    req.principal = p;
  };
  // The limiter attaches itself to routes through an onRoute hook, so it must be loaded BEFORE the route
  // is declared. A plain `app.register(rateLimit)` is deferred and would leave the route unlimited.
  // Only routes that set `config.rateLimit` are limited; `preHandler` lets the key be the verified user.
  app.register(async (scope) => {
    await scope.register(rateLimit, {
      global: false,
      hook: 'preHandler',
      errorResponseBuilder: (_req, ctx) => Object.assign(new Error('rate_limited'), { status: 429, retryAfterSec: Math.ceil(ctx.ttl / 1000) }),
    });
    scope.post('/assist/triage', {
      preHandler: requireCustomer, // the limiter's hook is added after this one, so it sees req.principal
      config: { rateLimit: { max: deps.triageRateLimitPerMin ?? 10, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.principal!.userId } },
    }, async (req) => {
      const p = req.principal!;
      const b = parse(triageBody, req.body);
      if (!deps.model) throw Object.assign(new Error('provider_not_configured'), { status: 503 });
      try {
        const r = await triage(deps.model, b.message, { abortSignal: AbortSignal.timeout(deps.triageTimeoutMs ?? 15_000) });
        const simulated = deps.demo === true;
        return {
          output: r.output,
          usage: r.usage,
          simulated,
          modelId: simulated ? DEMO_MODEL_ID : (r.modelId ?? 'unknown'),
          authenticatedAs: { userId: p.userId, role: p.role },
        };
      } catch (err) {
        const classified = classifyProviderError(err);
        if (!classified) throw err;
        req.log.warn(safeErrorFields(err, classified.message), 'assist: provider call failed');
        throw classified;
      }
    });
  });

  return app;
}
