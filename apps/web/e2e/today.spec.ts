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

  await expect(page.getByRole('heading', { name: 'Today\'s schedule' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Dr. Nkem Okafor' })).toBeVisible();

  const did = page.locator('table').filter({ hasText: 'Calls answered' });
  await expect(did.getByRole('columnheader', { name: 'Last 7 days' })).toBeVisible();
  await expect(did.getByRole('row', { name: /Calls answered/ }).getByRole('cell').nth(2)).toHaveText('15');
  await expect(page.getByText('Browser tests are not counted.', { exact: false })).toBeVisible();

  await expect(page.getByRole('list', { name: 'Recent calls' }).getByRole('listitem')).toHaveCount(5);

  // claiming from Today takes the request and opens the queue
  await attention.getByRole('button', { name: 'Claim' }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByText('You have it').first()).toBeVisible();
});
