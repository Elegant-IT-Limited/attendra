import { type Browser, expect } from '@playwright/test';
import { STATE } from './auth-state';

/** A page already signed in as one of the demo logins, opened on the call list. */
export async function openAs(browser: Browser, role: keyof typeof STATE) {
  const context = await browser.newContext({ storageState: STATE[role] });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/c\/[^/]+\/calls$/);
  return page;
}
