// What the client accepts from the API. TypeScript casts do not check data at run time; these do.
// Unknown extra fields are dropped; a missing or wrongly typed field is a handled error, not a crash.
import { z } from 'zod';

export const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string(),
  expiresIn: z.number(),
});

export const TriageResponseSchema = z.object({
  output: z.object({
    intent: z.enum(['order_status', 'refund_request', 'menu_question', 'complaint', 'other']),
    language: z.enum(['en', 'hi', 'hinglish']),
    needsHuman: z.boolean(),
    summary: z.string(),
  }),
  usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
  /** true: the server is in demo mode and nothing here came from a real model. */
  simulated: z.boolean(),
  modelId: z.string(),
  authenticatedAs: z.object({ userId: z.string(), role: z.string() }).optional(),
});

export const ErrorBodySchema = z.object({ error: z.string() });
