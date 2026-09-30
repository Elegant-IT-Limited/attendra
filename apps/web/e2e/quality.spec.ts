import { expect, test } from '@playwright/test';
import { openAs } from './session';

test('a manager sees how the assistant is doing, and opens the calls behind a number', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  await page.getByRole('link', { name: 'Quality' }).first().click();
  await expect(page.getByRole('heading', { name: 'Quality', exact: true })).toBeVisible();
  const booking = page.getByTestId('quality-booking');
  await expect(booking).toContainText('Booking success');
  await expect(page.getByTestId('quality-containment')).toContainText('%');
  await expect(page.getByRole('heading', { name: 'Week by week' })).toBeVisible();
  // each week starts on a date written day first, as everywhere else
  await expect(page.locator('tbody tr').first().locator('td').first()).toHaveText(/^\d{1,2} [A-Z][a-z]{2}$/);
  await booking.click();
  await expect(page).toHaveURL(/\/calls\?.*outcome=booked/, { timeout: 20_000 });
  await expect(page.getByLabel('Outcome')).toHaveValue('booked');
  await expect(page.getByLabel('From')).not.toHaveValue('');
  // this week may have no bookings yet, depending on the day: the list or its empty state, filtered either way
  await expect(page.locator('tbody tr').first().or(page.getByText('No calls here'))).toBeVisible();
});

test('the front desk does not see Quality', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await expect(page.getByRole('link', { name: 'Quality' })).toHaveCount(0);
});
