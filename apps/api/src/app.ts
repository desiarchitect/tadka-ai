import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken, type SigningKeys } from './identity/access-tokens.js';
import { IdentityService } from './identity/service.js';
import type { LanguageModel } from 'ai';
import type { ProviderOptions } from './llm/types.js';
import { runTurn, type LoopConfig, type TurnOptions } from './assist/agent-loop.js';
import type { BudgetLedger } from './assist/budget.js';
import { rulesClassifier, type IntentClassifier } from './assist/classifiers.js';
import type { SecurityAudit } from './assist/tools/audit.js';
import { registerConversationRoutes } from './assist/conversation-routes.js';
import { registerAssistRoutes } from './assist/routes.js';
import { ConversationsService, MemoriesService, type Prefs } from './memory/service.js';
import { OrdersService } from './orders/service.js';
import type { PaymentProvider } from './payments/provider.js';
import { PaymentsService } from './payments/service.js';
import { RestaurantsService } from './restaurants/service.js';
import type { Db } from './shared/db.js';
import { UnauthorizedError } from './shared/errors.js';
import type { Principal } from './shared/principal.js';

// `providerOptions` and `config.priceKey` come from the ModelHandle built in src/llm.
export type AssistantDeps = { model: LanguageModel; providerOptions: ProviderOptions; ledger: BudgetLedger; config: LoopConfig; audit: SecurityAudit; historyBudgetBytes?: number };
// `logStream`: send the API's logs here instead (tests use it to check what is logged).
export type AppDeps = { db: Db; keys: SigningKeys; provider: PaymentProvider; classify?: IntentClassifier; assistant?: AssistantDeps; logStream?: { write(line: string): void } };

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logStream ? { level: 'info', stream: deps.logStream } : process.env.NODE_ENV !== 'test' && { level: 'info' } });
  const identity = new IdentityService(deps.db, deps.keys);
  const restaurants = new RestaurantsService(deps.db);
  const payments = new PaymentsService(deps.db, deps.provider);
  const orders = new OrdersService(deps.db, payments);
  const conversations = new ConversationsService(deps.db);
  const memories = new MemoriesService(deps.db);

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

  const a = deps.assistant;
  const chat = a && ((p: Principal, text: string, opts: TurnOptions & { prefs?: Prefs } = {}) => runTurn({
    model: a.model, providerOptions: a.providerOptions, ledger: a.ledger, config: a.config,
    executor: { orders, restaurants, prefs: opts.prefs, audit: a.audit, log: (line) => app.log.info(line) },
    log: (e) => app.log.warn(e),
  }, p, text, opts));
  registerAssistRoutes(app, { orders, principal, parse, classify: deps.classify ?? rulesClassifier, chat, memories });
  registerConversationRoutes(app, { principal, parse, chat, conversations, memories, historyBudgetBytes: a?.historyBudgetBytes });

  return app;
}
