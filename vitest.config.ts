import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'evals/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/web/e2e/**'],
    // PGlite boots a real Postgres in-process; give the first test in each file room to start it
    testTimeout: 20_000,
    // and the API suites boot Postgres, Better Auth and Nest before the first test
    hookTimeout: 60_000,
  },
});
