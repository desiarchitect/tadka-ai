import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    fileParallelism: false, // the integration tests share one database
    env: { NODE_ENV: 'test' },
  },
});
