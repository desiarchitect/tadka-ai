// The assist routes. They sit beside the domain routes and call the same public service
// interfaces; they never read the database themselves.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OrdersService } from '../orders/service.js';
import type { Principal } from '../shared/principal.js';

type Deps = {
  orders: OrdersService;
  principal: (req: FastifyRequest) => Promise<Principal>;
  parse: <T>(schema: z.ZodType<T>, v: unknown) => T;
};

const orderStatusQuery = z.object({ orderId: z.uuid() });

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
}
