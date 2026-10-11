// DELIBERATELY BROKEN FIXTURE. Do not copy. Never imported by src/.
//
// The obvious way to keep a growing chat under the context limit: keep the last N messages.
// It counts messages, not turns, so the cut can land between a tool call and its result.
// The window then starts with a tool result whose call is gone, and the provider rejects
// the whole request (HTTP 400). src/assist/history.ts keeps whole turns instead.
import type { ModelMessage } from 'ai';

export function keepLastMessages(history: ModelMessage[], n: number): ModelMessage[] {
  return history.slice(-n);
}
