// EP3: conversations the assistant remembers, and the customer's saved preferences.
// Customers only. The identity comes from the token; every service call is scoped by it,
// so another customer's conversation is 404, the same as an id that doesn't exist.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConversationsService, MemoriesService, Prefs } from '../memory/service.js';
import { ForbiddenError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import type { TurnOptions, TurnResult } from './agent-loop.js';
import { clientGone, perUserLimit, requireCustomer, sendFailedTurn } from './guard.js';
import { HISTORY_BUDGET_BYTES, selectHistory } from './history.js';

type Deps = {
  principal: (req: FastifyRequest) => Promise<Principal>;
  parse: <T>(schema: z.ZodType<T>, v: unknown) => T;
  chat?: (p: Principal, text: string, opts?: TurnOptions & { prefs?: Prefs }) => Promise<TurnResult>;
  conversations: ConversationsService;
  memories: MemoriesService;
  historyBudgetBytes?: number;
  /** Per-user model-spending requests a minute (the same setting as the other assist routes). */
  rateLimitPerMin?: number;
};

const idParam = z.object({ id: z.uuid() });
const textBody = z.strictObject({ text: z.string().trim().min(1).max(500) });
const memoryParam = z.object({ kind: z.enum(['diet']) });
const memoryBody = z.strictObject({ value: z.enum(['vegetarian']) });

export function registerConversationRoutes(app: FastifyInstance, deps: Deps) {
  const customer = async (req: FastifyRequest) => {
    const p = await deps.principal(req);
    if (p.role !== 'Customer') throw new ForbiddenError('customers_only');
    return p;
  };

  app.post('/assist/conversations', async (req, reply) => reply.code(201).send(await deps.conversations.create(await customer(req))));
  app.get('/assist/conversations', async (req) => deps.conversations.list(await customer(req)));
  app.get('/assist/conversations/:id', async (req) => deps.conversations.history(await customer(req), deps.parse(idParam, req.params).id));
  app.delete('/assist/conversations/:id', async (req, reply) => {
    await deps.conversations.delete(await customer(req), deps.parse(idParam, req.params).id);
    return reply.code(204).send();
  });

  // One turn: load the stored history, send the newest whole turns that fit the budget, run
  // the loop, then store this turn. The store only succeeds if no other turn committed in
  // the meantime (409 conversation_busy), so two tabs can't interleave a conversation.
  // Guarded like the other model-spending routes: customers only, a per-user limit (429), the turn is aborted when the client
  // goes away (and then nothing is stored), and a turn that did not answer is a non-2xx with a machine-readable `error`.
  // `app` must be a scope in which registerAssistLimiter() has been awaited (see guard.ts).
  app.post('/assist/conversations/:id/messages', {
    preHandler: requireCustomer(deps.principal, 'customers_only'),
    config: perUserLimit(deps.rateLimitPerMin),
  }, async (req, reply) => {
    const p = req.principal!;
    const { id } = deps.parse(idParam, req.params);
    const { text } = deps.parse(textBody, req.body);
    const state = await deps.conversations.loadForTurn(p, id);
    if (!deps.chat) throw Object.assign(new Error('assistant_not_configured'), { status: 503 });
    const h = selectHistory(state.turns, deps.historyBudgetBytes ?? HISTORY_BUDGET_BYTES);
    const gone = clientGone(reply);
    try {
      const r = await deps.chat(p, text, { history: h.messages, turnNo: state.nextTurnNo, prefs: await deps.memories.get(p), signal: gone.signal });
      // The client left: the turn was abandoned, so nothing is stored and the conversation is exactly as it was.
      if (r.stopReason === 'cancelled') return reply.code(499).send();
      await deps.conversations.appendTurn(p, id, state.version, state.nextTurnNo, {
        userText: text, answer: r.answer, stopReason: r.stopReason, steps: r.steps, messages: r.turnMessages,
      });
      // Never log the customer's text or the answer.
      req.log.info({ event: 'assist.turn', turnNo: state.nextTurnNo, stopReason: r.stopReason, turnsSent: h.turnsSent, turnsDropped: h.turnsDropped });
      if (r.failure) return sendFailedTurn(req, reply, '/assist/conversations/:id/messages', r.failure, r);
      return { answer: r.answer, stopReason: r.stopReason, steps: r.steps, context: { turnsSent: h.turnsSent, turnsDropped: h.turnsDropped, historyBytes: h.historyBytes } };
    } finally {
      gone.release();
    }
  });

  // Long-term memory: only what the customer chose to save, from an allow-list.
  app.get('/assist/memories', async (req) => deps.memories.get(await customer(req)));
  app.put('/assist/memories/:kind', async (req) => {
    const p = await customer(req);
    const { kind } = deps.parse(memoryParam, req.params);
    const { value } = deps.parse(memoryBody, req.body);
    await deps.memories.set(p, kind, value);
    return deps.memories.get(p);
  });
  app.delete('/assist/memories/:kind', async (req, reply) => {
    await deps.memories.delete(await customer(req), deps.parse(memoryParam, req.params).kind);
    return reply.code(204).send();
  });
}
