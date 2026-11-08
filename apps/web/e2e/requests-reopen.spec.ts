import { expect, test } from '@playwright/test';
import { openAs } from './session';

// Batch 4b: an emergency's urgent request says where it came from and links the call (REQ-2), who added a request
// with their role or "the assistant" (REQ-1), and a closed request reopened, in its history, and on another open
// Requests page at once (REQ-3). The demo clinic's own requests; made-up people only.
test('an emergency\'s urgent request is labelled and links its call, and says the assistant added it', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  // the urgent check every emergency call leaves (the worker): urgent, from an emergency call
  const row = page.getByTestId('task-row').filter({ hasText: 'Emergency' }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Added by the assistant');
  await row.click();
  const card = page.getByTestId('task');
  const from = card.getByTestId('from-call');
  await expect(from).toHaveText(/^From an emergency call, /);
  await expect(card.getByTestId('added-by')).toHaveText('Added by the assistant');
  await from.click();
  await expect(page).toHaveURL(/\/calls\/[^/]+$/);
  await expect(page.getByText(/Emergency language on this call|Emergency ·|Emergency cleared/).first()).toBeVisible();
});

test('a closed request is reopened, says so in its history, and shows up on another open Requests page at once', async ({ browser }) => {
  test.slow();
  const desk = await openAs(browser, 'frontdesk');
  // the manager watches the open list in another browser: the reopened request must reach it without a reload
  const manager = await openAs(browser, 'manager');
  await manager.getByRole('link', { name: /^Requests/ }).click();
  await expect(manager.getByTestId('task-row').first()).toBeVisible();

  await desk.getByRole('link', { name: /^Requests/ }).click();
  const rows = desk.getByTestId('task-row');
  const row = rows.filter({ hasText: 'Unclaimed' }).filter({ hasNotText: /Urgent|Emergency/ }).first();
  await expect(row).toBeVisible();
  const number = ((await row.getByTestId('request-number').textContent()) ?? '').trim();
  expect(number).toMatch(/^R-\d+$/);
  await row.click();
  const card = desk.getByTestId('task');
  await card.getByRole('button', { name: 'Mark done' }).click();
  await card.getByRole('button', { name: 'Mark done' }).click();
  await expect(card).toHaveCount(0);
  await expect(manager.getByTestId('request-number').filter({ hasText: new RegExp(`^${number}$`) })).toHaveCount(0);

  await desk.getByRole('button', { name: 'Done', exact: true }).click();
  await rows.filter({ has: desk.getByTestId('request-number').filter({ hasText: new RegExp(`^${number}$`) }) }).click();
  await card.getByRole('button', { name: 'Reopen' }).click();
  await expect(desk.getByText(`Reopened. ${number} is back in the open queue.`)).toBeVisible();
  await desk.getByRole('button', { name: 'Show it' }).click();
  await expect(desk.getByRole('button', { name: 'Open', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const reopened = desk.getByTestId('task');
  await expect(reopened.getByText('Unclaimed')).toBeVisible();
  // its history: who closed it and who reopened it, by name and role
  await reopened.getByTestId('request-history').getByText('History').click();
  const history = reopened.getByTestId('request-history');
  await expect(history.getByText('Closed a request')).toBeVisible();
  await expect(history.getByText('Reopened a request')).toBeVisible();
  await expect(history).toContainText('Jordan (front desk) (Front desk)');
  // the manager's open list has it back, with no reload
  await expect(manager.getByTestId('request-number').filter({ hasText: new RegExp(`^${number}$`) })).toHaveCount(1, { timeout: 15_000 });
});
