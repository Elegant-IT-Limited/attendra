import { expect, test } from '@playwright/test';
import { openAs } from './session';

// Refreshes the README screenshots from the demo clinic. Skipped unless asked for:
//   SCREENSHOTS=1 pnpm test:e2e --grep screenshots
const out = (name: string) => `../../docs/images/${name}.png`;

test.describe('screenshots', () => {
  test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to refresh docs/images');
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

  // The specs run against `next dev`; its corner badge has no place in the README.
  const hideDevBadge = (p: import('@playwright/test').Page) => p.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important; }';
      document.head.append(style);
    });
  });

  test('dashboard pages', async ({ page: signedOut, browser }) => {
    await hideDevBadge(signedOut);
    await signedOut.goto('/sign-in');
    await expect(signedOut.getByText('Demo clinic, synthetic patients')).toBeVisible();
    await signedOut.screenshot({ path: out('sign-in') });
    const page = await openAs(browser, 'manager', hideDevBadge);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('tbody tr')).toHaveCount(15);
    await page.screenshot({ path: out('calls') });

    await page.getByRole('tab', { name: 'Bookings and changes' }).click();
    await page.locator('tbody tr').last().getByRole('link').click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/); // the list's cells also contain the tool names
    await expect(page.getByText('Identity check', { exact: true })).toBeVisible();
    await page.screenshot({ path: out('call-detail'), fullPage: true });

    await page.getByRole('link', { name: 'All calls' }).click();
    await page.getByText('Emergency', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/);
    await expect(page.getByText('Emergency language on this call')).toBeVisible();
    await page.screenshot({ path: out('call-emergency') });

    await page.getByRole('link', { name: /Tasks/ }).click();
    await expect(page.getByTestId('task').first()).toBeVisible();
    await page.screenshot({ path: out('tasks') });

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByLabel('Greeting')).toBeVisible();
    await page.screenshot({ path: out('settings') });

    await page.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.screenshot({ path: out('audit') });
  });
});
