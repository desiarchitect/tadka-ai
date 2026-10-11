import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shared/schema.ts',
  out: './migrations',
  schemaFilter: ['identity', 'restaurant', 'ordering', 'payment', 'assist'],
});
