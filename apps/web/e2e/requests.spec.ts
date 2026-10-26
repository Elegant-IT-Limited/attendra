import { expect, test } from '@playwright/test';
import { openAs } from './session';

test('front desk claims a refill request, adds a note, and closes it with an outcome', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  // what each kind means folds away; open it to read the refill line
  await page.getByText('What each kind of request means').click();
  await expect(page.getByText('The patient asked for a refill. Check with the care team, then call them back.')).toBeVisible();

  await page.getByLabel('Type').selectOption({ label: 'Prescription refill' });
  // the queue is a list of rows; a row opens its request in the side panel
  const row = page.getByTestId('task-row').filter({ hasText: 'Unclaimed' }).first();
  await row.click();
  const card = page.getByTestId('task');
  await expect(card.getByText(/Prescription refill, came in/)).toBeVisible();
  // whose request it is, from the panel's title ("Name: Prescription refill"), to find it again among the done ones
  const name = ((await page.getByRole('dialog').getByRole('heading').first().textContent()) ?? '').split(':')[0]!.trim();
  expect(name.length).toBeGreaterThan(0);
  await card.getByRole('button', { name: 'Claim' }).click();
  await expect(card.getByText('You have it')).toBeVisible();

  await card.getByLabel('Add a note for the team').fill('Pharmacy confirmed they have it in stock.');
  await card.getByRole('button', { name: 'Add note' }).click();
  await expect(card.getByText('Pharmacy confirmed they have it in stock.')).toBeVisible();
  await expect(card.getByText(/Jordan \(front desk\),/)).toBeVisible();

  await card.getByRole('button', { name: 'Mark done' }).click();
  // the front desk is not marked as approving refills: a vet decides
  await expect(card.getByLabel('Outcome').locator('option', { hasText: 'Refill sent to the pharmacy' })).toBeDisabled();
  await expect(card.getByText(/decides this one/)).toBeVisible();
  await card.getByLabel('Outcome').selectOption({ label: 'Called back' });
  await card.getByRole('button', { name: 'Mark done' }).click();
  // done, it leaves the open list, and its panel closes with it
  await expect(card).toHaveCount(0);

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByTestId('task-row').filter({ hasText: name }).filter({ hasText: 'Called back' }).first().click();
  const done = page.getByTestId('task');
  await expect(done.getByText('Pharmacy confirmed they have it in stock.')).toBeVisible();
  await expect(done.getByText('Called back', { exact: true })).toBeVisible();
  // when it was closed and by whom, not when it came in
  await expect(done.getByText(/^Prescription refill, closed \w{3} \d{1,2} \w{3} \d{1,2}:\d{2} [AP]M by Jordan \(front desk\)$/)).toBeVisible();

  // from its call, the closed request opens on the Done tab
  await done.getByRole('link', { name: /^The call, / }).click();
  await expect(page).toHaveURL(/\/calls\/[^/]+$/);
  await page.getByRole('link', { name: /Prescription refill\s*Done/ }).click();
  await expect(page).toHaveURL(/\/requests\?status=done$/);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('task-row').filter({ hasText: name }).first()).toBeVisible();
});

test('an old /tasks link lands on Requests with its filter', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/tasks?status=done`);
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/requests\\?status=done$`), { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a claim someone else won says so once', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await page.route((u) => u.pathname.endsWith('/claim'), (route) => route.fulfill({ status: 409, json: { error: 'task_taken', message: 'Someone else holds this request, or it is already done.' } }));
  await page.getByTestId('task-row').filter({ hasText: 'Unclaimed' }).first().click();
  await page.getByTestId('task').getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByText('Someone else holds this request, or it is already done.')).toHaveCount(1);
});

test('a manager gives a request to the front desk, takes it, gives it back, and releases it', async ({ browser }) => {
  // the demo's senior login is the practice manager; the list is the same for an owner, who is always on it
  const page = await openAs(browser, 'manager');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  await page.getByTestId('task-row').filter({ hasText: 'Unclaimed' }).first().click();
  const card = page.getByTestId('task');
  await expect(card.getByText('Unclaimed')).toBeVisible();
  const assign = card.getByLabel('Assign to');
  // everyone who works requests, the manager included; nobody holds it yet
  await expect(assign).toHaveValue('');
  await expect(assign.locator('option', { hasText: 'Jordan (front desk)' })).toHaveCount(1);
  await expect(assign.locator('option', { hasText: 'Priya (practice manager) (you)' })).toHaveCount(1);

  await assign.selectOption({ label: 'Jordan (front desk)' });
  await expect(page.getByText('Given to Jordan (front desk).')).toBeVisible();
  await expect(card.getByText('Jordan (front desk) has it')).toBeVisible();
  await expect(assign.locator('option:checked')).toHaveText('Jordan (front desk), has it');

  // taken back: the manager gives it to themselves
  await assign.selectOption({ label: 'Priya (practice manager) (you)' });
  await expect(card.getByText('You have it')).toBeVisible();
  await expect(assign.locator('option:checked')).toHaveText('Priya (practice manager) (you), has it');

  await assign.selectOption({ label: 'Jordan (front desk)' });
  await expect(card.getByText('Jordan (front desk) has it')).toBeVisible();

  // and back to the queue
  await assign.selectOption({ label: 'Unassigned' });
  await expect(page.getByText('Released. It is back in the queue.')).toBeVisible();
  await expect(card.getByText('Unclaimed')).toBeVisible();
  await expect(assign).toHaveValue('');
});
