import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { STATE } from './auth-state';

/**
 * Every signed-in page polls the API (the request count, live calls, the plan) and refetches on each change
 * the change feed sends, all from one address against the API's 600 a minute. Pages the earlier tests left
 * open kept doing so to the end of the run; past about forty of them one change to a request set off over a
 * hundred requests, and the tests after it got 429s. So a context lives only as long as the test that opened
 * it: the next one closes it.
 */
const opened: { testId: string; context: BrowserContext }[] = [];

/** A new browser context for this test, closed when a later test opens its own. */
export async function newContext(browser: Browser, options?: Parameters<Browser['newContext']>[0]) {
  const testId = test.info().testId;
  const earlier = opened.filter((o) => o.testId !== testId);
  opened.splice(0, opened.length, ...opened.filter((o) => o.testId === testId));
  for (const o of earlier) await o.context.close().catch(() => {}); // already closed by its test: nothing to do
  const context = await browser.newContext(options);
  opened.push({ testId, context });
  return context;
}

/** A page already signed in as one of the demo logins, opened on Today. */
export async function openAs(browser: Browser, role: keyof typeof STATE, prepare?: (page: Page) => Promise<unknown>) {
  const context = await newContext(browser, { storageState: STATE[role] });
  const page = await context.newPage();
  await prepare?.(page);
  await page.goto('/');
  // the Today screen; the redirect waits on /me, which a busy dev server or CI runner can take many seconds
  // to answer, and now and then never makes: then the page is loaded once more (main runs #236, #243)
  const today = /\/c\/[^/]+$/;
  try {
    await expect(page).toHaveURL(today, { timeout: 20_000 });
  } catch {
    await page.goto('/');
    await expect(page).toHaveURL(today, { timeout: 30_000 });
  }
  return page;
}

/**
 * Submits a sign-in, and when the limiter answers 429 (a few sign-ins close together in
 * a run), waits out its retry time and tries again, at most twice. The limiter stays on.
 */
export async function signInPatiently(page: Page, submit: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    const answered = page.waitForResponse((r) => r.url().includes('/api/auth/sign-in') && r.request().method() === 'POST');
    await submit();
    const res = await answered;
    if (res.status() !== 429 || attempt === 2) return;
    const seconds = Number(res.headers()['retry-after'] ?? res.headers()['x-retry-after'] ?? 10);
    await page.waitForTimeout((Number.isFinite(seconds) && seconds > 0 ? seconds : 10) * 1000 + 250);
  }
}

/** A fresh sign-in, for specs that run after another spec has signed a shared login out. */
export async function signInAgain(browser: Browser, label: 'Practice manager' | 'Front desk' | 'Cedar Park front desk' | 'Vet clinic manager') {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/sign-in');
  await signInPatiently(page, () => page.getByRole('button', { name: label, exact: true }).click());
  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  return page;
}
