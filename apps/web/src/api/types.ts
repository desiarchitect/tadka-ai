import type { z } from 'zod';
import type { ConversationHistorySchema, ConversationListSchema, ConversationReplySchema, PrefsSchema, ChatFailureBodySchema, ChatResponseSchema, IntentResponseSchema, LoginResponseSchema, MenuSchema, NextStepSchema, OrderStatusResponseSchema, OrderDetailSchema, OrderSchema, RestaurantSchema, TriageResponseSchema } from './schema.js';

export type TriageResponse = z.infer<typeof TriageResponseSchema>;
export type TriageOutput = TriageResponse['output'];
export type TriageIntent = TriageOutput['intent'];
export type TriageLanguage = TriageOutput['language'];
export type IntentResponse = z.infer<typeof IntentResponseSchema>;
export type NextStep = z.infer<typeof NextStepSchema>;
export type OrderStatusResponse = z.infer<typeof OrderStatusResponseSchema>;
export type ConversationSummary = z.infer<typeof ConversationListSchema>[number];
export type ConversationHistory = z.infer<typeof ConversationHistorySchema>;
export type ConversationReply = z.infer<typeof ConversationReplySchema>;
export type Prefs = z.infer<typeof PrefsSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type ChatStep = ChatResponse['steps'][number];
/** What a failed chat turn leaves for the page (every field validated). */
export type ChatFailure = { code: string; answer: string | undefined; stopReason: string | undefined; steps: ChatStep[]; retryAfterSec?: number };
export type ChatFailureBody = z.infer<typeof ChatFailureBodySchema>;
export type Restaurant = z.infer<typeof RestaurantSchema>;
export type Menu = z.infer<typeof MenuSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type OrderDetail = z.infer<typeof OrderDetailSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export type ApiDiagnostics = {
  httpStatus: number;
  statusText: string;
  outcome: 'success' | 'error';
  traceId: string | null;
  requestId: string | null;
  durationMs: number;
  authenticated: boolean;
  userRole?: string;
  userId?: string;
  modelId?: string;
  simulated?: boolean;
  /** false: the call is known not to involve a model (sign-in). true or absent: a model may be involved and this endpoint does not say which one. */
  modelInvolved?: boolean;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  errorCode?: string;
  errorMessage?: string;
  timestamp: string;
};
