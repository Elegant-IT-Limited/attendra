// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { E2E_PROVISIONING_TOKEN } from './e2e/auth-state';

// E2E_CLOCK=2026-11-02T08:00:00Z runs the suite as if it started then: the demo API's clock (and so its seeded
// visits) and every page's clock run that far from the real one, for checks that depend on the hour. The offset
// is fixed once here; the workers inherit it.
if (process.env.E2E_CLOCK && !process.env.E2E_CLOCK_OFFSET) process.env.E2E_CLOCK_OFFSET = String(Date.parse(process.env.E2E_CLOCK) - Date.now());
const clockOffset = process.env.E2E_CLOCK_OFFSET;
const shifted: Record<string, string> = clockOffset ? { E2E_CLOCK_OFFSET: clockOffset, NODE_OPTIONS: `--import ${fileURLToPath(new URL('./e2e/fake-clock.mjs', import.meta.url))}` } : {};

// E2E_WEB_PORT, E2E_API_PORT and E2E_VOICE_PORT run the suite on other ports (3000, 8081 and 8080 by default), so two
// runs on one machine (two working copies) do not share servers. Specs that write the origin out as localhost:3000
// need the default ports.
const webPort = Number(process.env.E2E_WEB_PORT ?? 3000);
const apiPort = Number(process.env.E2E_API_PORT ?? 8081);
const ports: Record<string, string> = { API_PORT: String(apiPort), PUBLIC_URL: `http://localhost:${webPort}`, ...(process.env.E2E_VOICE_PORT ? { VOICE_PORT: process.env.E2E_VOICE_PORT } : {}) };

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
  use: { baseURL: `http://localhost:${webPort}`, trace: 'retain-on-failure' },
  // next dev compiles each page the first time it is opened, which on a busy machine takes
  // longer than the default 5 seconds; a check still fails when the page is wrong, only later
  expect: { timeout: 15_000 },
  // and a whole test the same room: its pages compile on first use, one after another
  timeout: 60_000,
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
    // test calls stay off even when a .env holds an OpenAI key: these specs never spend credit. The provisioning
    // token is this suite's own, made up here: first-day.spec.ts opens an empty clinic the way the hosting layer does
    { command: 'pnpm --filter @attendra/api demo', env: { ATTENDRA_TEST_CALLS: 'off', ATTENDRA_SIMULATED_CALLS: 'on', ATTENDRA_WEBHOOKS_ALLOW_LOCAL: 'on', ATTENDRA_PROVISIONING_TOKEN: E2E_PROVISIONING_TOKEN, ...shifted, ...ports }, url: `http://127.0.0.1:${apiPort}/api/v1/health`, reuseExistingServer: !process.env.CI && !process.env.E2E_CLOCK, timeout: 120_000 },
    webPort === 3000 && apiPort === 8081
      ? { command: 'pnpm --filter @attendra/web dev', url: 'http://localhost:3000/sign-in', reuseExistingServer: !process.env.CI, timeout: 120_000 }
      : { command: `pnpm --filter @attendra/web exec next dev --port ${webPort}`, env: { API_URL: `http://127.0.0.1:${apiPort}` }, url: `http://localhost:${webPort}/sign-in`, reuseExistingServer: false, timeout: 120_000 },
  ],
});
