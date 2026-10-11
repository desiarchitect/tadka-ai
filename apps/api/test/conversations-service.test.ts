// EP3: conversations and memories at the service level. Real database.
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConversationsService, MemoriesService, RETENTION_DAYS } from '../src/memory/service.js';
import { ConflictError, NotFoundError } from '../src/shared/errors.js';
import type { Principal } from '../src/shared/principal.js';
import { conversations, memories, messages, turns } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
let svc: ConversationsService;
let mem: MemoriesService;
const rahul: Principal = { userId: IDS.rahul, role: 'Customer' };
const aman: Principal = { userId: IDS.aman, role: 'Customer' };
const INVENTED = '99999999-9999-4999-8999-999999999999';
const turn = (n: number) => ({ userText: `q${n}`, answer: `a${n}`, stopReason: 'answered', steps: [], messages: [{ role: 'user', content: `q${n}` }, { role: 'assistant', content: `x${n}` }] });
const caught = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { return e as Error; } throw new Error('expected a throw'); };

beforeAll(async () => {
  stack = await startStack();
  svc = new ConversationsService(stack.db);
  mem = new MemoriesService(stack.db);
});

describe('conversations', () => {
  it('stores whole turns in order and loads them grouped by turn', async () => {
    const { conversationId: id } = await svc.create(rahul);
    let s = await svc.loadForTurn(rahul, id);
    expect(s).toMatchObject({ version: 0, nextTurnNo: 1, turns: [] });
    await svc.appendTurn(rahul, id, 0, 1, turn(1));
    s = await svc.loadForTurn(rahul, id);
    await svc.appendTurn(rahul, id, s.version, s.nextTurnNo, turn(2));
    s = await svc.loadForTurn(rahul, id);
    expect(s.turns).toEqual([
      { turnNo: 1, messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'x1' }] },
      { turnNo: 2, messages: [{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'x2' }] },
    ]);
    expect((await svc.history(rahul, id)).turns.map((t) => [t.text, t.answer])).toEqual([['q1', 'a1'], ['q2', 'a2']]);
    expect((await svc.list(rahul)).map((c) => c.conversationId)).toContain(id);
  });

  it("another customer's conversation is not found, exactly like an invented id", async () => {
    const { conversationId: id } = await svc.create(rahul);
    for (const fn of [() => svc.history(aman, id), () => svc.loadForTurn(aman, id), () => svc.delete(aman, id), () => svc.appendTurn(aman, id, 0, 1, turn(1))]) {
      const e = await caught(fn);
      expect(e.message).toMatch(/conversation_not_found|conversation_busy/);
    }
    const foreign = await caught(() => svc.history(aman, id)) as NotFoundError;
    const invented = await caught(() => svc.history(aman, INVENTED)) as NotFoundError;
    expect(foreign.message).toBe(invented.message);
    expect([foreign.denied, invented.denied]).toEqual([true, false]);
    expect((await svc.list(aman)).map((c) => c.conversationId)).not.toContain(id);
    expect((await svc.history(rahul, id)).turns).toEqual([]); // nothing was appended
  });

  it('two turns committed against the same version: one wins, the other is 409 and writes nothing', async () => {
    const { conversationId: id } = await svc.create(rahul);
    const results = await Promise.allSettled([svc.appendTurn(rahul, id, 0, 1, turn(1)), svc.appendTurn(rahul, id, 0, 1, turn(9))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect((await stack.db.select().from(turns).where(eq(turns.conversationId, id)))).toHaveLength(1);
    expect((await stack.db.select().from(messages).where(eq(messages.conversationId, id)))).toHaveLength(2);
  });

  it('a full conversation refuses another turn', async () => {
    const { conversationId: id } = await svc.create(rahul);
    await stack.db.update(conversations).set({ turnCount: 50 }).where(eq(conversations.id, id));
    expect((await caught(() => svc.loadForTurn(rahul, id))).message).toBe('conversation_full');
  });

  it('delete removes the turns and messages, and nothing of anyone else', async () => {
    const mine = (await svc.create(rahul)).conversationId;
    const his = (await svc.create(aman)).conversationId;
    await svc.appendTurn(rahul, mine, 0, 1, turn(1));
    await svc.appendTurn(aman, his, 0, 1, turn(1));
    await svc.delete(rahul, mine);
    expect(await stack.db.select().from(messages).where(eq(messages.conversationId, mine))).toEqual([]);
    expect(await stack.db.select().from(turns).where(eq(turns.conversationId, mine))).toEqual([]);
    expect((await svc.history(aman, his)).turns).toHaveLength(1);
  });

  it(`retention: deleted after ${RETENTION_DAYS} days without a message, kept before`, async () => {
    const now = new Date('2026-10-11T12:00:00Z');
    const day = 24 * 3600 * 1000;
    const old = (await svc.create(rahul)).conversationId;
    const fresh = (await svc.create(rahul)).conversationId;
    await stack.db.update(conversations).set({ lastMessageAt: new Date(now.getTime() - RETENTION_DAYS * day - 1000) }).where(eq(conversations.id, old));
    await stack.db.update(conversations).set({ lastMessageAt: new Date(now.getTime() - RETENTION_DAYS * day + 1000) }).where(eq(conversations.id, fresh));
    await svc.purgeExpired(now);
    const left = (await stack.db.select({ id: conversations.id }).from(conversations)).map((r) => r.id);
    expect(left).not.toContain(old);
    expect(left).toContain(fresh);
  });
});

describe('memories', () => {
  it('only the customer can read and delete their own preference', async () => {
    await mem.set(rahul, 'diet', 'vegetarian');
    expect(await mem.get(rahul)).toEqual({ diet: 'vegetarian' });
    expect(await mem.get(aman)).toEqual({});
    expect((await caught(() => mem.delete(aman, 'diet'))).message).toBe('memory_not_found');
    await mem.delete(rahul, 'diet');
    expect(await mem.get(rahul)).toEqual({});
  });

  it('the database refuses anything outside the allow-list', async () => {
    const e = await caught(() => stack.db.insert(memories).values({ userId: IDS.rahul, kind: 'address', value: 'House 7' }));
    expect(String((e as { cause?: unknown }).cause ?? e)).toMatch(/memories_kind_ck/);
    expect((await stack.db.execute(sql`select count(*)::int as n from assist.memories where kind <> 'diet'`)).rows[0]).toEqual({ n: 0 });
  });
});
