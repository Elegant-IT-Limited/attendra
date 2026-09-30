import { type Browser, expect, type Page } from '@playwright/test';
import { STATE } from './auth-state';

/** A page already signed in as one of the demo logins, opened on Today. */
export async function openAs(browser: Browser, role: keyof typeof STATE, prepare?: (page: Page) => Promise<unknown>) {
  const context = await browser.newContext({ storageState: STATE[role] });
  const page = await context.newPage();
  await prepare?.(page);
  await page.goto('/');
  // the Today screen; the redirect waits on /me, which a busy dev server can take a few seconds to answer
  await expect(page).toHaveURL(/\/c\/[^/]+$/, { timeout: 15_000 });
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
export async function signInAgain(browser: Browser, label: 'Practice manager' | 'Front desk' | 'Cedar Park front desk') {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/sign-in');
  await signInPatiently(page, () => page.getByRole('button', { name: label, exact: true }).click());
  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  return page;
}
