// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, devices } from '@playwright/test';

// The demo API (in-memory Postgres, 15 recorded calls) and the dashboard, started fresh
// for every run. The setup project signs in once per role (sign-in is rate limited,
// as it should be); the specs then run in order against that one shared demo clinic,
// with no retries, because they change it.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [
    { name: 'sign-in', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['sign-in'] },
  ],
  webServer: [
    { command: 'pnpm --filter @attendra/api demo', url: 'http://127.0.0.1:8081/api/v1/health', reuseExistingServer: !process.env.CI, timeout: 120_000 },
    { command: 'pnpm --filter @attendra/web dev', url: 'http://localhost:3000/sign-in', reuseExistingServer: !process.env.CI, timeout: 120_000 },
  ],
});
