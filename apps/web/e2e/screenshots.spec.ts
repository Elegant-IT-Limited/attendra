import { expect, test } from '@playwright/test';
import { openAs } from './session';

// Refreshes the README screenshots from the demo clinic, and only those four. Skipped unless asked for:
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

  test('dashboard pages', async ({ browser }) => {
    const page = await openAs(browser, 'manager', hideDevBadge);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    // the list has loaded, however many calls the demo recorded and the other specs added
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expect(page.getByText('Loading', { exact: false })).toHaveCount(0);
    await page.screenshot({ path: out('calls') });

    await page.getByRole('tab', { name: 'Bookings and changes' }).click();
    await page.locator('tbody tr').last().getByRole('link').click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/); // the list's cells also contain the tool names
    await expect(page.getByText('Identity check', { exact: true })).toBeVisible();
    await page.screenshot({ path: out('call-detail'), fullPage: true });

    await page.getByRole('link', { name: /^Requests/ }).click();
    await expect(page.getByTestId('task').first()).toBeVisible();
    await page.screenshot({ path: out('tasks') });

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByLabel('Greeting')).toBeVisible();
    await page.screenshot({ path: out('settings') });
  });
});
