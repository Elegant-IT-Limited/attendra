// SPDX-License-Identifier: AGPL-3.0-only
import { type Browser, chromium, type Page } from '@playwright/test';
import { cookiesFor } from './options';
import type { CallAttempt } from './report';

/**
 * A browser for a set of calls. Chromium's fake microphone plays one file for the whole browser, so each caller's
 * script gets a browser of its own; a simulated call needs no audio. The page asks for the microphone itself.
 */
export function launch(audioFile: string | null, headed: boolean): Promise<Browser> {
  return chromium.launch({
    headless: !headed,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(audioFile ? [`--use-file-for-fake-audio-capture=${audioFile}`] : [])],
  });
}

export interface Slot {
  browser: Browser; base: string; clinicId: string; cookie: string; slot: number;
  mode: 'real' | 'simulated';
  startAt: number; deadline: number; callMs: number;
  attempts: CallAttempt[];
  onRateLimited: () => void;
  log: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const iso = () => new Date().toISOString();
const PHASES = /^(Ready|Connecting…|Live|Ending…|Call ended)$/;

/** The test call page's own words for its phase, or null while it is not showing one. */
async function phase(page: Page): Promise<string | null> {
  const el = page.locator('p.font-medium').filter({ hasText: PHASES }).first();
  return (await el.count()) ? (await el.textContent())?.trim() ?? null : null;
}

/** The message of the page's "The test call stopped" notice (a dialog), when it shows one; the dialog is closed. */
async function stopped(page: Page): Promise<string | null> {
  const dialog = page.getByRole('dialog', { name: 'The test call stopped' });
  if (!(await dialog.count())) return null;
  const text = (await dialog.textContent())?.replace('The test call stopped', '').trim();
  await page.keyboard.press('Escape');
  return text || 'stopped';
}

/** Any notice left open (a refused start, "Busy for a moment") would hold the next click: closed first. */
async function closeNotices(page: Page) {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
}

/**
 * One line kept busy from its start to the deadline: dial, hold the call for --call-seconds (or until the deadline),
 * hang up, dial again. A call that ends early by itself is dialled again too; one that never went live, or stopped
 * with the page's error, is a failure.
 */
export async function runSlot(s: Slot): Promise<void> {
  const context = await s.browser.newContext({ baseURL: s.base, permissions: ['microphone'] });
  await context.addCookies(cookiesFor(s.cookie, s.base));
  const page = await context.newPage();
  page.on('response', (r) => { if (r.status() === 429 && r.url().includes('/api/')) s.onRateLimited(); });
  await sleep(s.startAt - Date.now());
  try {
    while (Date.now() < s.deadline - 5000) {
      const attempt: CallAttempt = { slot: s.slot, clinicId: s.clinicId, callId: null, dialledAt: iso(), liveAt: null, endedAt: null, endedBy: 'failed', failure: null };
      s.attempts.push(attempt);
      try {
        await (s.mode === 'real' ? realCall(page, s, attempt) : simulatedCall(page, s, attempt));
      } catch (err) {
        attempt.endedBy = 'failed';
        attempt.failure ??= (err as Error).message.split('\n')[0]!.slice(0, 160);
      }
      attempt.endedAt ??= iso();
      s.log(`slot ${s.slot}: ${attempt.callId?.slice(0, 8) ?? 'no call'} ${attempt.endedBy}${attempt.failure ? ` (${attempt.failure})` : ''}`);
      // a failure is not retried at once: a refused start would otherwise spin
      if (attempt.endedBy === 'failed') await sleep(Math.min(10_000, s.deadline - Date.now()));
    }
  } finally {
    await context.close().catch(() => {}); // the browser may already be gone at the end
  }
}

/** The page's start request, POST /api/v1/clinics/:id/test-calls(/simulated), and the call id it answered with. */
async function started(page: Page, path: RegExp, attempt: CallAttempt, click: () => Promise<void>) {
  const answer = page.waitForResponse((r) => r.request().method() === 'POST' && path.test(new URL(r.url()).pathname), { timeout: 30_000 });
  await click();
  const res = await answer;
  const body = (await res.json().catch(() => ({}))) as { callId?: string; error?: string };
  if (res.status() !== 201 || !body.callId) throw new Error(`start answered ${res.status()}${body.error ? ` ${body.error}` : ''}`);
  attempt.callId = body.callId;
}

async function openTestCall(page: Page, s: Slot) {
  await page.goto(`/c/${s.clinicId}/test-call`);
  if (new URL(page.url()).pathname.startsWith('/sign-in')) throw new Error('signed out: the session cookie is not valid here');
}

async function realCall(page: Page, s: Slot, attempt: CallAttempt) {
  if (!page.url().includes('/test-call')) await openTestCall(page, s);
  await closeNotices(page);
  const start = page.getByRole('button', { name: /^(Start test call|Call again)$/ });
  await start.waitFor({ timeout: 60_000 });
  await started(page, /\/api\/v1\/clinics\/[^/]+\/test-calls$/, attempt, () => start.click());
  const until = Date.now() + 30_000;
  while ((await phase(page)) !== 'Live') {
    const failure = await stopped(page);
    if (failure || Date.now() > until) throw new Error(failure ?? 'never went live');
    await sleep(250);
  }
  attempt.liveAt = iso();
  const hangUpAt = Math.min(Date.now() + s.callMs, s.deadline);
  while (Date.now() < hangUpAt) {
    const now = await phase(page);
    if (now !== 'Live') {
      const failure = await stopped(page);
      attempt.endedAt = iso();
      attempt.endedBy = failure ? 'failed' : 'itself';
      attempt.failure = failure;
      return;
    }
    await sleep(1000);
  }
  await page.getByRole('button', { name: 'End call' }).click();
  await page.locator('p.font-medium').filter({ hasText: /^Call ended$/ }).waitFor({ timeout: 20_000 });
  attempt.endedAt = iso();
  attempt.endedBy = 'script';
}

async function simulatedCall(page: Page, s: Slot, attempt: CallAttempt) {
  await openTestCall(page, s);
  const play = page.getByRole('button', { name: 'Play a simulated call' });
  await play.waitFor({ timeout: 60_000 });
  await started(page, /\/api\/v1\/clinics\/[^/]+\/test-calls\/simulated$/, attempt, () => play.click());
  await page.waitForURL(/\/calls\/[^/]+\/live$/, { timeout: 30_000 });
  const bar = page.getByRole('region', { name: 'Test call in progress' });
  await bar.waitFor({ timeout: 30_000 });
  attempt.liveAt = iso();
  const hangUpAt = Math.min(Date.now() + s.callMs, s.deadline);
  while (Date.now() < hangUpAt) {
    if (!(await bar.count())) { attempt.endedAt = iso(); attempt.endedBy = 'itself'; return; }
    await sleep(1000);
  }
  await bar.getByRole('button', { name: 'Hang up' }).click();
  await bar.waitFor({ state: 'detached', timeout: 30_000 });
  attempt.endedAt = iso();
  attempt.endedBy = 'script';
}
