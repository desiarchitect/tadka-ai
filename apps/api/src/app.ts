import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken, type SigningKeys } from './identity/access-tokens.js';
import { IdentityService } from './identity/service.js';
import { registerAssistRoutes } from './assist/routes.js';
import { OrdersService } from './orders/service.js';
import type { PaymentProvider } from './payments/provider.js';
import { PaymentsService } from './payments/service.js';
import { RestaurantsService } from './restaurants/service.js';
import type { Db } from './shared/db.js';
import { UnauthorizedError } from './shared/errors.js';
import type { Principal } from './shared/principal.js';

export type AppDeps = { db: Db; keys: SigningKeys; provider: PaymentProvider };

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && { level: 'info' } });
  const identity = new IdentityService(deps.db, deps.keys);
  const restaurants = new RestaurantsService(deps.db);
  const payments = new PaymentsService(deps.db, deps.provider);
  const orders = new OrdersService(deps.db, payments);

  // Map domain errors to HTTP. Anything without a status is a 500 with no details.
  app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, _req, reply) => {
    const status = err.status ?? (err.statusCode && err.statusCode < 500 ? err.statusCode : 500);
    if (status >= 500 && !err.status) app.log.error(err);
    reply.code(status).send({ error: status >= 500 && !err.status ? 'internal_error' : err.message });
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

  registerAssistRoutes(app, { orders, principal, parse });

  return app;
}
