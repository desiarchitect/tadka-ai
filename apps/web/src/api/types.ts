import type { z } from 'zod';
import type { LoginResponseSchema, TriageResponseSchema } from './schema.js';

export type TriageResponse = z.infer<typeof TriageResponseSchema>;
export type TriageOutput = TriageResponse['output'];
export type TriageIntent = TriageOutput['intent'];
export type TriageLanguage = TriageOutput['language'];
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
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  errorCode?: string;
  errorMessage?: string;
  timestamp: string;
};
