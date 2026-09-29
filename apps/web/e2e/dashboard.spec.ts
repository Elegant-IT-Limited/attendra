import { expect, test } from '@playwright/test';
import { openAs } from './session';

test.describe.serial('the front desk, end to end on the demo clinic', () => {
  test('a manager sees the week of calls', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Calls' })).toBeVisible();
    await expect(page.getByText('Demo mode.')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(15);
    await page.getByRole('tab', { name: 'Needs attention' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(5); // 3 tasks for staff, 2 emergencies
  });

  test('a booking call shows the transcript, the read-back and every tool step', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await page.getByRole('tab', { name: 'Bookings and changes' }).click();
    await page.locator('tbody tr').last().getByRole('link').click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/); // the list's cells also contain the tool names
    await expect(page.getByText('Thanks for calling Maple Street Family Medicine.')).toBeVisible();
    await expect(page.getByText(/Just to confirm: .* Is that right\?/)).toBeVisible();
    await expect(page.getByText('Identity check', { exact: true })).toBeVisible();
    await expect(page.getByText('Confirmed change', { exact: true })).toBeVisible();
  });

  test('an emergency call is flagged at the top', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await page.locator('tbody').getByText('Emergency', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/);
    await expect(page.getByText('Emergency language on this call')).toBeVisible();
  });

  test('front desk claims a refill, releases it, claims it again and closes it', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.getByRole('link', { name: /^Requests/ }).click();
    const tasks = page.getByTestId('task');
    await expect(tasks).toHaveCount(3);
    const first = tasks.first();
    await expect(first.getByText('James Whitaker')).toBeVisible();
    await first.getByRole('button', { name: 'Claim' }).click();
    await expect(first.getByText('You have it')).toBeVisible();
    await first.getByRole('button', { name: 'Release' }).click();
    await expect(first.getByText('Unclaimed')).toBeVisible();
    await first.getByRole('button', { name: 'Claim' }).click();
    await first.getByRole('button', { name: 'Mark done' }).click();
    await first.getByLabel('Outcome').selectOption({ label: 'Refill sent to the pharmacy' });
    await first.getByRole('button', { name: 'Mark done' }).click();
    await expect(tasks).toHaveCount(2);
    await page.getByRole('tab', { name: 'Done' }).click();
    await expect(tasks).toHaveCount(1);
  });

  test('front desk cannot change settings or open the audit log', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByText('A practice manager or owner can change them.')).toBeVisible();
    await expect(page.getByLabel('Greeting')).toBeDisabled();
  });

  test('a greeting that hides the AI is refused; a holiday saves and is audited', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Settings' }).click();
    const greeting = page.getByLabel('Greeting');
    const original = await greeting.inputValue();
    await greeting.fill('Thanks for calling Maple Street. How can I help?');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('the greeting must disclose that the caller is speaking with an AI assistant')).toBeVisible();
    await greeting.fill(original);
    await page.getByLabel('Holiday date').fill('2026-12-31');
    await page.getByRole('button', { name: 'Add holiday' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. The next call uses these settings.')).toBeVisible();
    await page.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByText('Changed clinic settings').first()).toBeVisible();
    await expect(page.getByText('Read a call transcript').first()).toBeVisible();
  });

  test('signing out clears the screen', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
