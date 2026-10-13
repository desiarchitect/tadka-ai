// The assist routes. They sit beside the domain routes and call the same public service
// interfaces; they never read the database themselves.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MemoriesService, Prefs } from '../memory/service.js';
import type { OrdersService } from '../orders/service.js';
import { UpstreamError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import type { TurnOptions, TurnResult } from './agent-loop.js';
import type { IntentClassifier } from './classifiers.js';
import { clientGone, perUserLimit, providerSignal, requireCustomer, sendFailedTurn } from './guard.js';
import { FALLBACK, nextStep } from './next-step.js';

type Deps = {
  orders: OrdersService;
  principal: (req: FastifyRequest) => Promise<Principal>;
  parse: <T>(schema: z.ZodType<T>, v: unknown) => T;
  classify: IntentClassifier;
  /** EP2/EP3: one tool-calling turn. `opts.signal` aborts it (client disconnect). Absent when no model is configured, or in demo mode. */
  chat?: (p: Principal, text: string, opts?: TurnOptions & { prefs?: Prefs }) => Promise<TurnResult>;
  memories: MemoriesService;
  /** True in demo mode: the answer came from the keyword rules, never a provider, and the response says `simulated: true`. */
  demo?: boolean;
  /** Per-user requests a minute and the longest wait for the provider: the same settings as /assist/triage. */
  rateLimitPerMin?: number;
  timeoutMs?: number;
};

const orderStatusQuery = z.object({ orderId: z.uuid() });
const textBody = z.strictObject({ text: z.string().trim().min(1).max(500) });

// `app` must be a scope in which registerAssistLimiter() has already been awaited (see guard.ts): the intent route
// is limited like /assist/triage. /assist/order-status calls no model, so it has no limiter config.
export function registerAssistRoutes(app: FastifyInstance, deps: Deps) {
  // No LLM here. A structured request ("status of order X") is answered by plain code:
  // the verified principal goes to the orders service, which enforces ownership. Someone
  // else's order is "not found", exactly as on GET /orders/:id.
  app.get('/assist/order-status', async (req) => {
    const p = await deps.principal(req);
    const { orderId } = deps.parse(orderStatusQuery, req.query);
    const o = await deps.orders.get(p, orderId);
    return { orderId: o.id, status: o.status };
  });

  // Free text in, a label out. The model classifies; this route and next-step.ts decide what
  // happens. The identity comes from the token, never from the body or the model. Customers
  // only: an Owner or Admin token gets 403, so the model never acts for an elevated role.
  // Guarded like /assist/triage: per-user limit, and one bounded provider call that is aborted at the timeout.
  app.post('/assist/intent', {
    preHandler: requireCustomer(deps.principal, 'customers_only'),
    config: perUserLimit(deps.rateLimitPerMin),
  }, async (req) => {
    const p = req.principal!;
    const { text } = deps.parse(textBody, req.body);
    const r = await deps.classify(text, { abortSignal: providerSignal(deps.timeoutMs) });
    const simulated = deps.demo === true;
    if (r.outcome !== 'ok') {
      // Safe by construction: a category, class names and numbers. Never the message, the model output or provider text.
      req.log.warn({ route: '/assist/intent', outcome: r.outcome, classifier: r.classifier, reason: r.reason, ...r.diag }, 'assist/intent: no intent was produced');
    }
    if (r.outcome === 'provider_error') throw new UpstreamError('assistant_unavailable');
    if (r.outcome !== 'ok') return { outcome: r.outcome, classifier: r.classifier, simulated, next: FALLBACK };
    return { outcome: 'ok', classifier: r.classifier, simulated, intent: r.intent, next: await nextStep(p, r.intent, deps.orders) };
  });

  // EP2: one question, answered with tools. The model chooses tools and which results answer
  // the question; the executor runs them with the verified Principal; the reply is rendered
  // from templates. Single turn, nothing stored (conversation memory is EP3). Customers only.
  // Guarded like the other model-spending routes: per-user limit (429), and the turn is aborted when the client goes away.
  // A turn that did not produce an answer is NOT a 200: see failureOf() in agent-loop.ts. The body still carries the fixed
  // fallback sentence for the UI, plus a machine-readable `error` code. Provider text never reaches the client.
  app.post('/assist/chat', {
    preHandler: requireCustomer(deps.principal, 'customers_only'),
    config: perUserLimit(deps.rateLimitPerMin),
  }, async (req, reply) => {
    const p = req.principal!;
    const { text } = deps.parse(textBody, req.body);
    if (!deps.chat) throw Object.assign(new Error('assistant_not_configured'), { status: 503 });
    const gone = clientGone(reply);
    try {
      const r = await deps.chat(p, text, { prefs: await deps.memories.get(p), signal: gone.signal });
      if (r.failure) return sendFailedTurn(req, reply, '/assist/chat', r.failure, r);
      return { answer: r.answer, stopReason: r.stopReason, steps: r.steps };
    } finally {
      gone.release();
    }
  });
}
