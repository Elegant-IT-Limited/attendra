// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, devices } from '@playwright/test';

// The demo API (in-memory Postgres, two demo clinics and their recorded calls) and the dashboard, started fresh
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
  // next dev compiles each page the first time it is opened, which on a busy machine takes
  // longer than the default 5 seconds; a check still fails when the page is wrong, only later
  expect: { timeout: 15_000 },
  projects: [
    { name: 'sign-in', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['sign-in'],
      // a fake microphone for the test call page
      use: { ...devices['Desktop Chrome'], permissions: ['microphone'], launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } },
    },
  ],
  webServer: [
    // test calls stay off even when a .env holds an OpenAI key: these specs never spend credit
    { command: 'pnpm --filter @attendra/api demo', env: { ATTENDRA_TEST_CALLS: 'off', ATTENDRA_SIMULATED_CALLS: 'on', ATTENDRA_WEBHOOKS_ALLOW_LOCAL: 'on' }, url: 'http://127.0.0.1:8081/api/v1/health', reuseExistingServer: !process.env.CI, timeout: 120_000 },
    { command: 'pnpm --filter @attendra/web dev', url: 'http://localhost:3000/sign-in', reuseExistingServer: !process.env.CI, timeout: 120_000 },
  ],
});
