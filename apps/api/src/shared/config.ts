import { z } from 'zod';

const env = z.object({
  DATABASE_URL: z.string().default('postgres://tadka:tadka_local@localhost:5544/tadka'),
  FAKE_PSP_URL: z.string().default('http://localhost:4010'),
  PORT: z.coerce.number().default(3000),
  // Optional Ed25519 private key as a JWK JSON string. Unset = a fresh dev key per process.
  JWT_PRIVATE_JWK: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  // The model provider settings (LLM_PROVIDER, AZURE_*, OPENAI_API_KEY) are read by src/llm.
  M0_BUDGET_USD: z.coerce.number().default(5),
  // POST /assist/chat (EP2). The price comes from the provider and model (src/llm/pricing.ts); a pair
  // with no price means the assistant refuses to send anything.
  ASSIST_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(400),
  ASSIST_TURN_BUDGET_USD: z.coerce.number().positive().default(0.05),
  ASSIST_ESTIMATE_MARGIN: z.coerce.number().min(1).default(1.25),
  // Key for the HMAC of requested ids in logs/security-audit.jsonl. Unset = a fresh key per process.
  AUDIT_HMAC_KEY: z.string().optional(),
});

export type Config = z.infer<typeof env>;
export const loadConfig = (): Config => env.parse(process.env);
