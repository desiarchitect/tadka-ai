// Conversations and memories (EP3). Every method is scoped by the principal: another user's
// conversation is "not found", exactly like an id that doesn't exist.
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../shared/db.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import { conversations, memories, MEMORY_KINDS, messages, turns } from '../shared/schema.js';

export const MAX_TURNS = 50;
export const RETENTION_DAYS = 30; // a choice for a synthetic teaching project

export type StoredTurn = { turnNo: number; messages: unknown[] };
export type NewTurn = { userText: string; answer: string; stopReason: string; steps: unknown; messages: unknown[] };
export type Prefs = { diet?: 'vegetarian' };

export class ConversationsService {
  constructor(private readonly db: Db) {}

  async create(p: Principal): Promise<{ conversationId: string }> {
    const [c] = await this.db.insert(conversations).values({ userId: p.userId }).returning({ id: conversations.id });
    return { conversationId: c!.id };
  }

  // The caller's own conversations, most recent first.
  list(p: Principal) {
    return this.db.select({ conversationId: conversations.id, turnCount: conversations.turnCount, createdAt: conversations.createdAt, lastMessageAt: conversations.lastMessageAt })
      .from(conversations).where(eq(conversations.userId, p.userId))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id)).limit(20);
  }

  // What the customer saw: their questions and the answers. Never the tool internals.
  async history(p: Principal, id: string) {
    const c = await this.findOwned(p, id);
    const rows = await this.db.select({ turnNo: turns.turnNo, text: turns.userText, answer: turns.answer, stopReason: turns.stopReason, at: turns.createdAt })
      .from(turns).where(eq(turns.conversationId, c.id)).orderBy(asc(turns.turnNo));
    return { conversationId: c.id, turns: rows };
  }

  // Everything the next turn needs: the version to commit against and the stored model
  // messages grouped into whole turns, oldest first.
  async loadForTurn(p: Principal, id: string) {
    const c = await this.findOwned(p, id);
    if (c.turnCount >= MAX_TURNS) throw new ConflictError('conversation_full');
    const rows = await this.db.select({ turnNo: messages.turnNo, content: messages.content })
      .from(messages).where(eq(messages.conversationId, c.id)).orderBy(asc(messages.seq));
    const byTurn = new Map<number, unknown[]>();
    for (const r of rows) (byTurn.get(r.turnNo) ?? byTurn.set(r.turnNo, []).get(r.turnNo)!).push(r.content);
    const stored: StoredTurn[] = [...byTurn].map(([turnNo, m]) => ({ turnNo, messages: m }));
    return { conversationId: c.id, version: c.version, nextTurnNo: c.turnCount + 1, turns: stored };
  }

  // One transaction: the turn, its messages and the conversation's new version. If another
  // turn committed since `expectedVersion` was read, nothing is written (409).
  async appendTurn(p: Principal, id: string, expectedVersion: number, turnNo: number, t: NewTurn) {
    await this.db.transaction(async (tx) => {
      const [c] = await tx.update(conversations)
        .set({ version: expectedVersion + 1, turnCount: turnNo, lastMessageAt: new Date() })
        .where(and(eq(conversations.id, id), eq(conversations.userId, p.userId), eq(conversations.version, expectedVersion)))
        .returning({ id: conversations.id });
      if (!c) throw new ConflictError('conversation_busy');
      await tx.insert(turns).values({ conversationId: id, turnNo, userText: t.userText, answer: t.answer, stopReason: t.stopReason, steps: t.steps });
      const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${messages.seq}), 0) + 1` }).from(messages).where(eq(messages.conversationId, id)) as [{ next: number }];
      if (t.messages.length) {
        await tx.insert(messages).values(t.messages.map((content, i) => ({ conversationId: id, turnNo, seq: Number(next) + i, content })));
      }
    });
  }

  // Deletes the conversation; its turns and messages go with it (same transaction, cascade).
  async delete(p: Principal, id: string) {
    const gone = await this.db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, p.userId))).returning({ id: conversations.id });
    if (!gone.length) throw new NotFoundError('conversation_not_found');
  }

  // Retention: conversations with no message for RETENTION_DAYS are deleted.
  async purgeExpired(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 3600 * 1000);
    const gone = await this.db.delete(conversations).where(lt(conversations.lastMessageAt, cutoff)).returning({ id: conversations.id });
    return gone.length;
  }

  // One statement, as for orders: the row if it's the caller's, plus whether the id exists.
  private async findOwned(p: Principal, id: string) {
    const [r] = await this.db
      .select({ exists: sql<boolean>`exists (select 1 from ${conversations} where ${conversations.id} = ${id})`, c: conversations })
      .from(sql`(select 1) as one`)
      .leftJoin(conversations, and(eq(conversations.id, id), eq(conversations.userId, p.userId)));
    if (!r?.c) throw new NotFoundError('conversation_not_found', { denied: r?.exists === true });
    return r.c;
  }
}

// Long-term memory: only the kinds and values in MEMORY_KINDS, set by the customer.
export class MemoriesService {
  constructor(private readonly db: Db) {}

  async get(p: Principal): Promise<Prefs> {
    const rows = await this.db.select().from(memories).where(eq(memories.userId, p.userId));
    return Object.fromEntries(rows.map((r) => [r.kind, r.value])) as Prefs;
  }

  async set(p: Principal, kind: keyof typeof MEMORY_KINDS, value: (typeof MEMORY_KINDS)[typeof kind][number]) {
    await this.db.insert(memories).values({ userId: p.userId, kind, value })
      .onConflictDoUpdate({ target: [memories.userId, memories.kind], set: { value, updatedAt: new Date() } });
  }

  async delete(p: Principal, kind: keyof typeof MEMORY_KINDS) {
    const gone = await this.db.delete(memories).where(and(eq(memories.userId, p.userId), eq(memories.kind, kind))).returning({ kind: memories.kind });
    if (!gone.length) throw new NotFoundError('memory_not_found');
  }
}
