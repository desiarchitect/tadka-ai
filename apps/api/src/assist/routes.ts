// The assist routes. They sit beside the domain routes and call the same public service
// interfaces; they never read the database themselves.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OrdersService } from '../orders/service.js';
import { ForbiddenError, UpstreamError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import type { IntentClassifier } from './classifiers.js';
import { FALLBACK, nextStep } from './next-step.js';

type Deps = {
  orders: OrdersService;
  principal: (req: FastifyRequest) => Promise<Principal>;
  parse: <T>(schema: z.ZodType<T>, v: unknown) => T;
  classify: IntentClassifier;
};

const orderStatusQuery = z.object({ orderId: z.uuid() });
const intentBody = z.strictObject({ text: z.string().trim().min(1).max(500) });

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
  app.post('/assist/intent', async (req) => {
    const p = await deps.principal(req);
    if (p.role !== 'Customer') throw new ForbiddenError('customers_only');
    const { text } = deps.parse(intentBody, req.body);
    const r = await deps.classify(text);
    if (r.outcome === 'provider_error') throw new UpstreamError('assistant_unavailable');
    if (r.outcome !== 'ok') return { outcome: r.outcome, classifier: r.classifier, next: FALLBACK };
    return { outcome: 'ok', classifier: r.classifier, intent: r.intent, next: await nextStep(p, r.intent, deps.orders) };
  });
}
