import { type Browser, expect, type Page } from '@playwright/test';
import { STATE } from './auth-state';

/** A page already signed in as one of the demo logins, opened on Today. */
export async function openAs(browser: Browser, role: keyof typeof STATE, prepare?: (page: Page) => Promise<unknown>) {
  const context = await browser.newContext({ storageState: STATE[role] });
  const page = await context.newPage();
  await prepare?.(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/c\/[^/]+$/); // the Today screen
  return page;
}

/** A fresh sign-in, for specs that run after another spec has signed a shared login out. */
export async function signInAgain(browser: Browser, label: 'Practice manager' | 'Front desk' | 'Dhanmondi front desk') {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/sign-in');
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  return page;
}
