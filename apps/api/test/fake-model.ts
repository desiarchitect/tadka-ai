// A scripted fake model for the EP2 loop tests: each entry is one step's tool calls or text.
// No network, no key, no cost.
import { MockLanguageModelV4 } from 'ai/test';

export type Step = { calls?: [string, unknown, string?][]; text?: string; finish?: string; usage?: { in?: number; out?: number }; delayMs?: number; throws?: Error };
const usageOf = (u: Step['usage'] = { in: 100, out: 20 }) => ({
  inputTokens: { total: u.in, noCache: u.in, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: u.out, text: u.out, reasoning: 0 },
});
export function scripted(steps: Step[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const s = steps[Math.min(i++, steps.length - 1)]!;
      if (s.delayMs) await new Promise((r, j) => { const t = setTimeout(r, s.delayMs); opts.abortSignal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
      if (s.throws) throw s.throws;
      const content = s.calls
        ? s.calls.map(([toolName, input, callId], k) => ({ type: 'tool-call' as const, toolCallId: callId ?? `call_${i}_${k}`, toolName, input: typeof input === 'string' ? input : JSON.stringify(input) }))
        : [{ type: 'text' as const, text: s.text ?? '' }];
      return { content, finishReason: { unified: (s.finish ?? (s.calls ? 'tool-calls' : 'stop')) as 'stop', raw: 'x' }, usage: usageOf(s.usage), warnings: [] };
    },
  });
}
export const present = (...resultIds: string[]): [string, unknown] => ['final_answer', { kind: 'present', resultIds, clarifyReason: 'none' }];
