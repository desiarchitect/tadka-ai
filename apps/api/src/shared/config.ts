import { z } from 'zod';

const env = z.object({
  DATABASE_URL: z.string().default('postgres://tadka:tadka_local@localhost:5544/tadka'),
  FAKE_PSP_URL: z.string().default('http://localhost:4010'),
  PORT: z.coerce.number().default(3000),
  // Optional Ed25519 private key as a JWK JSON string. Unset = a fresh dev key per process.
  JWT_PRIVATE_JWK: z.string().optional(),
  // Both set: POST /assist/intent uses the Foundry model. Otherwise it uses the keyword rules.
  AZURE_RESOURCE_NAME: z.string().optional(),
  AZURE_API_KEY: z.string().optional(),
  AZURE_DEPLOYMENT: z.string().optional(),
  M0_BUDGET_USD: z.coerce.number().default(5),
  // POST /assist/chat (EP2). The deployment above is priced as ASSIST_PRICED_AS; a name with
  // no price in assist/budget.ts means the assistant refuses to send anything.
  ASSIST_PRICED_AS: z.string().default('gpt-5.4-mini'),
  ASSIST_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(400),
  ASSIST_TURN_BUDGET_USD: z.coerce.number().positive().default(0.05),
  ASSIST_ESTIMATE_MARGIN: z.coerce.number().min(1).default(1.25),
  // Key for the HMAC of requested ids in logs/security-audit.jsonl. Unset = a fresh key per process.
  AUDIT_HMAC_KEY: z.string().optional(),
});

export type Config = z.infer<typeof env>;
export const loadConfig = (): Config => env.parse(process.env);
