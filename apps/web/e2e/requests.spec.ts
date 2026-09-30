import { expect, test } from '@playwright/test';
import { openAs } from './session';

test('front desk claims a refill request, adds a note, and closes it with an outcome', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  await expect(page.getByText('The patient asked for a refill. Check with the care team, then call them back.')).toBeVisible();

  await page.getByLabel('Type').selectOption({ label: 'Prescription refill' });
  const card = page.getByTestId('task').first();
  await expect(card.getByText(/Prescription refill, came in/)).toBeVisible();
  await card.getByRole('button', { name: 'Claim' }).click();
  await expect(card.getByText('You have it')).toBeVisible();

  await card.getByLabel('Add a note for the team').fill('Pharmacy confirmed they have it in stock.');
  await card.getByRole('button', { name: 'Add note' }).click();
  await expect(card.getByText('Pharmacy confirmed they have it in stock.')).toBeVisible();
  await expect(card.getByText(/Jordan \(front desk\),/)).toBeVisible();

  await card.getByRole('button', { name: 'Mark done' }).click();
  await card.getByLabel('Outcome').selectOption({ label: 'Refill sent to the pharmacy' });
  await card.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByTestId('task').filter({ hasText: 'Pharmacy confirmed they have it in stock.' })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Done' }).click();
  const done = page.getByTestId('task').filter({ hasText: 'Pharmacy confirmed they have it in stock.' });
  await expect(done.getByText('Refill sent to the pharmacy')).toBeVisible();
  // when it was closed and by whom, not when it came in
  await expect(done.getByText(/^Prescription refill, closed \w{3} \d{1,2} \w{3} \d{1,2}:\d{2} [AP]M by Jordan \(front desk\)$/)).toBeVisible();

  // from its call, the closed request opens on the Done tab
  await done.getByRole('link', { name: /^The call, / }).click();
  await expect(page).toHaveURL(/\/calls\/[^/]+$/);
  await page.getByRole('link', { name: /Prescription refill\s*Done/ }).click();
  await expect(page).toHaveURL(/\/requests\?status=done$/);
  await expect(page.getByRole('tab', { name: 'Done' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('task').filter({ hasText: 'Pharmacy confirmed they have it in stock.' })).toBeVisible();
});

test('an old /tasks link lands on Requests with its filter', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/tasks?status=done`);
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/requests\\?status=done$`), { timeout: 20_000 });
  await expect(page.getByRole('tab', { name: 'Done' })).toHaveAttribute('aria-selected', 'true');
});

test('a claim someone else won says so once', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await page.route((u) => u.pathname.endsWith('/claim'), (route) => route.fulfill({ status: 409, json: { error: 'task_taken', message: 'Someone else holds this request, or it is already done.' } }));
  await page.getByTestId('task').first().getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByText('Someone else holds this request, or it is already done.')).toHaveCount(1);
});
