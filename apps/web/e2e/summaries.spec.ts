import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

test.describe.serial('call summaries', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await openAs(browser, 'manager'); });

  test('a booking call shows its summary, with what the caller wanted and how they came across', async () => {
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await page.getByRole('tab', { name: 'Bookings and changes' }).click();
    await page.locator('tbody tr').last().getByRole('link').click();
    const card = page.getByTestId('call-summary');
    await expect(card).toContainText('The assistant booked an appointment after the caller confirmed it.');
    await expect(card.getByText('Booking', { exact: true })).toBeVisible();
    await expect(card.getByText('Calm', { exact: true })).toBeVisible();
    await expect(card.getByText('From the call\'s facts')).toBeVisible();
  });

  test('flagged calls have their own filter, and leave it once someone has reviewed them', async () => {
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await page.getByRole('tab', { name: 'Needs review' }).click();
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    expect(before).toBeGreaterThan(0);
    await expect(rows.filter({ hasText: 'Needs review' })).toHaveCount(before);

    await rows.first().getByRole('link').click();
    const card = page.getByTestId('call-summary');
    await expect(card.getByText('Why review:')).toBeVisible();
    await card.getByRole('button', { name: 'Mark as reviewed' }).click();
    await expect(card.getByText('Reviewed by Priya (practice manager).')).toBeVisible();

    await page.getByRole('link', { name: 'All calls' }).click();
    await page.getByRole('tab', { name: 'Needs review' }).click();
    // one fewer flagged call, whether that leaves some or none
    await expect(rows.filter({ hasText: 'Needs review' })).toHaveCount(before - 1);
  });

  test('a request the assistant created shows the suggested next step', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.getByRole('link', { name: /^Requests/ }).click();
    await expect(page.getByTestId('task').filter({ hasText: 'Suggested' }).first()).toContainText(/Review the refill request|Call the caller back|Call back/);
  });
});
