import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'evals/test/**/*.test.ts'],
    // PGlite boots a real Postgres in-process; give the first test in each file room to start it
    testTimeout: 20_000,
  },
});
