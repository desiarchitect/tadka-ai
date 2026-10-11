// EP3: pair-safe history. A tool call and its result must always travel together.
import { APICallError, generateText, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { keepLastMessages } from '../demo/naive-trim.js';
import { SYSTEM_PROMPT } from '../src/assist/agent-loop.js';
import { contextNote, pairProblem, selectHistory, type StoredTurn } from '../src/assist/history.js';

const ORDER = '0000000a-0000-4000-8000-000000000000';
const REST = 'aaaaaaaa-0000-4000-8000-000000000001';
const call = (id: string, toolName = 'get_order', input: object = { orderId: ORDER }) => ({ type: 'tool-call' as const, toolCallId: id, toolName, input });
const result = (id: string, value: unknown, toolName = 'get_order') => ({ type: 'tool-result' as const, toolCallId: id, toolName, output: { type: 'json' as const, value: value as never } });
const orderResult = { status: 'ok', data: { kind: 'order', order: { orderId: ORDER, restaurantId: REST, status: 'Preparing', totalPaise: 59800, placedAt: '2026-10-01T12:00:00Z' } } };
const menuResult = { status: 'ok', data: { kind: 'menu', restaurant: { restaurantId: REST, name: 'Spice Garden', city: 'Pune' }, items: [{ itemId: 'i', name: 'Butter Naan', pricePaise: 4900, veg: true }], totalItems: 1, truncated: false, dataLabel: 'x' } };

// One stored turn: question, two parallel tool calls, their results, the final answer pair.
function turn(n: number): StoredTurn {
  return {
    turnNo: n,
    messages: [
      { role: 'user', content: `question ${n}` },
      { role: 'assistant', content: [call(`c${n}a`), call(`c${n}b`, 'get_restaurant_menu', { restaurantId: REST })] },
      { role: 'tool', content: [result(`c${n}a`, orderResult), result(`c${n}b`, menuResult, 'get_restaurant_menu')] },
      { role: 'assistant', content: [call(`c${n}f`, 'final_answer', { kind: 'present', resultIds: [`t${n}r1`], clarifyReason: 'none' })] },
      { role: 'tool', content: [result(`c${n}f`, { status: 'shown' }, 'final_answer')] },
    ],
  };
}
const flat = (ts: StoredTurn[]) => ts.flatMap((t) => t.messages as ModelMessage[]);

// A stand-in for the provider's rule: a tool result must answer a call in the same request.
// (The real provider's wording is recorded on the live run; the rule is the same.)
const strictProvider = () => new MockLanguageModelV4({
  doGenerate: async (opts) => {
    const seen = new Set<string>();
    for (const m of opts.prompt) {
      for (const part of Array.isArray(m.content) ? m.content : []) {
        if (typeof part === 'object' && part.type === 'tool-call') seen.add(part.toolCallId);
        if (typeof part === 'object' && part.type === 'tool-result' && !seen.has(part.toolCallId)) {
          throw new APICallError({ message: `No tool call found for function call output with call_id ${part.toolCallId}.`, url: 'stand-in', requestBodyValues: {}, statusCode: 400, isRetryable: false });
        }
      }
    }
    return { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
  },
});

describe('the naive fix crashes (the failure)', () => {
  it('keeping the last 6 messages cuts a tool result away from its call, and the provider says 400', async () => {
    const window = keepLastMessages(flat([turn(1), turn(2)]), 6);
    expect(window[0]!.role).toBe('tool'); // starts with a result whose call was cut
    expect(pairProblem(window)).toMatch(/^orphan_result:/);
    const err = await generateText({ model: strictProvider(), messages: [...window, { role: 'user', content: 'and now?' }], maxRetries: 0 }).catch((e) => e);
    expect(APICallError.isInstance(err) && err.statusCode).toBe(400);
  });
});

describe('pair-safe trimming (the fix)', () => {
  it('every budget gives whole turns, newest first, and a history the provider accepts', async () => {
    const turns = [1, 2, 3, 4, 5].map(turn);
    for (let budget = 0; budget <= 12_000; budget += 250) {
      const h = selectHistory(turns, budget);
      expect(pairProblem(h.messages)).toBeNull();
      expect(h.turnsSent + h.turnsDropped).toBe(5);
      const firstQuestion = h.messages.find((m) => m.role === 'user' && String(m.content).startsWith('question'));
      if (h.turnsSent) expect(firstQuestion!.content).toBe(`question ${6 - h.turnsSent}`);
    }
    const h = selectHistory(turns, 2500);
    await expect(generateText({ model: strictProvider(), messages: [...h.messages, { role: 'user', content: 'and now?' }], maxRetries: 0 })).resolves.toBeTruthy();
  });

  it('dropped turns become one note with quoted names and ids, never a status or a price, and the model is told what it is', () => {
    const note = contextNote([turn(1)]);
    expect(note).toContain(ORDER);
    expect(note).toContain('restaurant "Spice Garden"'); // quoted: a name is data, not an instruction
    expect(SYSTEM_PROMPT).toContain('is written by the application, not by the customer');
    expect(note).not.toMatch(/Preparing|598|49\.00|4900|Butter Naan/);
    const h = selectHistory([turn(1), turn(2)], 1);
    expect(h.messages).toEqual([{ role: 'user', content: expect.stringContaining('[Note from the application') }]);
  });
});

describe('pairProblem', () => {
  it('finds orphan results, unanswered calls and duplicates', () => {
    const u = { role: 'user' as const, content: 'q' };
    expect(pairProblem(flat([turn(1)]))).toBeNull();
    expect(pairProblem([u, { role: 'tool', content: [result('x', {})] }])).toBe('orphan_result:x');
    expect(pairProblem([u, { role: 'assistant', content: [call('x')] }, u])).toBe('unanswered_call:x');
    expect(pairProblem([u, { role: 'assistant', content: [call('x')] }])).toBe('unanswered_call:x');
    expect(pairProblem([u, { role: 'assistant', content: [call('x')] }, { role: 'tool', content: [result('x', {}), result('x', {})] }])).toBe('duplicate_result:x');
    expect(pairProblem([u, { role: 'assistant', content: [call('x')] }, { role: 'tool', content: [result('x', {})] }, { role: 'assistant', content: [call('x')] }])).toBe('duplicate_call:x');
  });
});
