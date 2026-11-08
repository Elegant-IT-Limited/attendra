// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

/** Every API request a page makes, as "GET /api/v1/…?…", in order. The change stream is a stream, not an answer: left out. */
function apiRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/v1/') && !u.pathname.endsWith('/changes')) seen.push(`${r.method()} ${u.pathname}${u.search}`);
  });
  return seen;
}
const twice = (seen: string[]) => [...new Set(seen.filter((x, i) => seen.indexOf(x) !== i))];

test('Today asks the API for each answer once on the way in (note 17)', async ({ browser }) => {
  let seen: string[] = [];
  const page = await openAs(browser, 'manager', async (p) => { seen = apiRequests(p); });
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.locator('[aria-label="At a glance"]')).toBeVisible();
  // everything Today asks for has gone out well within this; the slow safety poll is minutes away
  await page.waitForTimeout(4000);
  test.info().annotations.push({ type: 'Today API requests', description: `${seen.length}: ${seen.join(', ')}` });
  process.stdout.write(`Today API requests: ${seen.length}, asked twice: ${twice(seen).length}\n  ${seen.join('\n  ')}\n`);
  expect(twice(seen), `asked for twice: ${seen.join(', ')}`).toEqual([]);
});

test('pointing at a sidebar link asks for its page\'s data ahead, and the page opens without asking again', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  const seen = apiRequests(page);
  const doctors = (x: string) => /^GET \/api\/v1\/clinics\/[^/]+\/doctors$/.test(x);
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Doctors' }).hover();
  await expect.poll(() => seen.filter(doctors).length).toBe(1);
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Doctors' }).click();
  await expect(page.getByRole('heading', { name: 'Doctors' })).toBeVisible();
  await expect(page.getByTestId('doctor').first()).toBeVisible();
  await page.waitForTimeout(1000);
  expect(seen.filter(doctors)).toHaveLength(1);
});

test('the API\'s own time and the database\'s reach the browser in Server-Timing, through the dashboard', async ({ page }) => {
  const res = await page.request.get('/api/v1/health');
  expect(res.headers()['server-timing']).toMatch(/^app;dur=[\d.]+, db;dur=[\d.]+;desc="1 query"$/);
});
