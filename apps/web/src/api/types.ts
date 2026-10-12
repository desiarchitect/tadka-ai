import type { z } from 'zod';
import type { IntentResponseSchema, LoginResponseSchema, MenuSchema, NextStepSchema, OrderStatusResponseSchema, OrderDetailSchema, OrderSchema, RestaurantSchema, TriageResponseSchema } from './schema.js';

export type TriageResponse = z.infer<typeof TriageResponseSchema>;
export type TriageOutput = TriageResponse['output'];
export type TriageIntent = TriageOutput['intent'];
export type TriageLanguage = TriageOutput['language'];
export type IntentResponse = z.infer<typeof IntentResponseSchema>;
export type NextStep = z.infer<typeof NextStepSchema>;
export type OrderStatusResponse = z.infer<typeof OrderStatusResponseSchema>;
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
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  errorCode?: string;
  errorMessage?: string;
  timestamp: string;
};
