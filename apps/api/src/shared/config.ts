import { z } from 'zod';

const env = z.object({
  DATABASE_URL: z.string().default('postgres://tadka:tadka_local@localhost:5544/tadka'),
  FAKE_PSP_URL: z.string().default('http://localhost:4010'),
  PORT: z.coerce.number().default(3000),
  // Optional Ed25519 private key as a JWK JSON string. Unset = a fresh dev key per process.
  JWT_PRIVATE_JWK: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  // Simulated triage answers. Only "1" turns it on; missing or empty is off; anything else is refused.
  DEMO_MODE: z.union([z.literal(''), z.enum(['0', '1'])]).optional().transform((v) => v === '1'),
  TRIAGE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  TRIAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  AZURE_RESOURCE_NAME: z.string().optional(),
  AZURE_API_KEY: z.string().optional(),
  AZURE_DEPLOYMENT: z.string().default('gpt-5.4-mini'),
  M0_BUDGET_USD: z.coerce.number().default(5),
});

export type Config = z.infer<typeof env>;
export const loadConfig = (source: Record<string, string | undefined> = process.env): Config => {
  const r = env.safeParse(source);
  if (r.success) return r.data;
  const bad = r.error.issues.map((i) => i.path.join('.') || 'config');
  throw new Error(bad.includes('DEMO_MODE') ? 'DEMO_MODE must be "1" or "0" (or empty). Refusing to start.' : `Invalid configuration: ${bad.join(', ')}`);
};
