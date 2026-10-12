// EP3: conversations the assistant remembers, and the customer's saved preferences.
// Customers only. The identity comes from the token; every service call is scoped by it,
// so another customer's conversation is 404, the same as an id that doesn't exist.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConversationsService, MemoriesService, Prefs } from '../memory/service.js';
import { ForbiddenError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import type { TurnOptions, TurnResult } from './agent-loop.js';
import { HISTORY_BUDGET_BYTES, selectHistory } from './history.js';

type Deps = {
  principal: (req: FastifyRequest) => Promise<Principal>;
  parse: <T>(schema: z.ZodType<T>, v: unknown) => T;
  chat?: (p: Principal, text: string, opts?: TurnOptions & { prefs?: Prefs }) => Promise<TurnResult>;
  conversations: ConversationsService;
  memories: MemoriesService;
  historyBudgetBytes?: number;
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
  app.post('/assist/conversations/:id/messages', async (req) => {
    const p = await customer(req);
    const { id } = deps.parse(idParam, req.params);
    const { text } = deps.parse(textBody, req.body);
    const state = await deps.conversations.loadForTurn(p, id);
    if (!deps.chat) throw Object.assign(new Error('assistant_not_configured'), { status: 503 });
    const h = selectHistory(state.turns, deps.historyBudgetBytes ?? HISTORY_BUDGET_BYTES);
    const r = await deps.chat(p, text, { history: h.messages, turnNo: state.nextTurnNo, prefs: await deps.memories.get(p) });
    await deps.conversations.appendTurn(p, id, state.version, state.nextTurnNo, {
      userText: text, answer: r.answer, stopReason: r.stopReason, steps: r.steps, messages: r.turnMessages,
    });
    // Never log the customer's text or the answer.
    req.log.info({ event: 'assist.turn', turnNo: state.nextTurnNo, stopReason: r.stopReason, turnsSent: h.turnsSent, turnsDropped: h.turnsDropped });
    return { answer: r.answer, stopReason: r.stopReason, steps: r.steps, context: { turnsSent: h.turnsSent, turnsDropped: h.turnsDropped, historyBytes: h.historyBytes } };
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
