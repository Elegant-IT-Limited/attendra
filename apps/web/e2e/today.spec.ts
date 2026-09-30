import { expect, test } from '@playwright/test';
import { openAs } from './session';

test('Today shows what needs attention, the day\'s appointments, what the assistant did and the latest calls', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByText(/times are .*\(America\/Denver\)/)).toBeVisible();

  // the demo's refill and callback requests are waiting, each with one clear action
  const attention = page.getByRole('list', { name: 'Needs attention' });
  await expect(attention.getByText(/Prescription refill|Callback/).first()).toBeVisible();
  await expect(attention.getByRole('button', { name: 'Claim' }).first()).toBeVisible();

  // the cards say the period they count
  const glance = page.getByLabel('At a glance');
  for (const label of ['Calls today', 'Booked, last 7 days', 'Requests waiting', 'After-hours calls']) await expect(glance.getByText(label, { exact: true })).toBeVisible();
  await expect(glance.getByText('Trend over the last 7 days')).toBeVisible();
  await expect(glance.getByText('Answered in the last 7 days')).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Today\'s schedule' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Dr. Nkem Okafor' })).toBeVisible();

  const did = page.locator('table').filter({ hasText: 'Calls answered' });
  await expect(did.getByRole('columnheader', { name: 'Last 7 days' })).toBeVisible();
  // how many of the demo's calls fall in the last 7 days depends on the weekday it runs
  await expect(did.getByRole('row', { name: /Calls answered/ }).getByRole('cell').nth(2)).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByText('Browser tests are not counted.', { exact: false })).toBeVisible();

  await expect(page.getByRole('list', { name: 'Recent calls' }).getByRole('listitem')).toHaveCount(5);

  // claiming from Today takes the request and opens the queue
  await attention.getByRole('button', { name: 'Claim' }).first().click();
  await expect(page).toHaveURL(/\/requests$/, { timeout: 20_000 }); // next dev may still be compiling the page
  await expect(page.getByText('You have it').first()).toBeVisible();
});

test('Requests waiting counts every waiting request, not only the 20 listed', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  // more waiting than the list holds: the route lists the oldest 20 and says how many in all
  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, type: 'callback', createdAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(), callId: null }));
  await page.route('**/tasks/waiting', (route) => route.fulfill({ json: { tasks, total: 23 } }));
  await page.reload();
  const card = page.locator('div').filter({ has: page.getByText('Requests waiting', { exact: true }) }).filter({ hasText: 'Nobody has them yet' }).last();
  await expect(card).toContainText('23');
});

test('the start page says so when the server fails, instead of loading for ever', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.route((u) => u.pathname === '/api/v1/me', (route) => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
  await page.goto('/');
  await expect(page.getByText('Attendra did not load')).toBeVisible({ timeout: 20_000 }); // after the query's own retries
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
