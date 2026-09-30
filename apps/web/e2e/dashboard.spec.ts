import { expect, test } from '@playwright/test';
import { openAs } from './session';

test.describe.serial('the front desk, end to end on the demo clinic', () => {
  test('a manager sees the week of calls', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Calls' })).toBeVisible();
    await expect(page.getByText('Demo mode.')).toBeVisible();
    // 25 eval scenarios in the weeks before, and 11 ordinary calls this week
    await expect(page.locator('tbody tr')).toHaveCount(36);
    // named for what it holds; Today's Needs attention is a different, wider list
    await expect(page.getByRole('tab', { name: 'Needs attention' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Emergencies and requests' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(9); // 6 requests for staff, 3 emergencies
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
    await expect(tasks).toHaveCount(6); // 4 from the eval calls, a refill and a callback from this week's
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
    await expect(tasks).toHaveCount(5);
    await page.getByRole('tab', { name: 'Done' }).click();
    await expect(tasks).toHaveCount(1);
  });

  test('the audit log says every action and every actor in words, not codes', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.goto(`/c/${new URL(page.url()).pathname.split('/')[2]}/audit`);
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const what = await rows.locator('td:nth-child(3)').allTextContents();
    const who = await rows.locator('td:nth-child(2)').allTextContents();
    expect(what.filter((w) => /^[a-z_]+(\.[a-z_:]+)+$/.test(w))).toEqual([]);
    expect(who.filter((w) => /^(worker|system|seed|api_key:)/.test(w))).toEqual([]);
  });

  test('front desk cannot change settings or open the audit log', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByText('A practice manager or owner can change them.')).toBeVisible();
    await expect(page.getByLabel('Greeting')).toBeDisabled();
  });

  test('the date filters on Calls say whose dates they are', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await expect(page.getByLabel('From')).toHaveAttribute('type', 'date');
    await expect(page.getByText('Times and dates are the clinic’s.')).toBeVisible();
    await page.close();
  });

  test('the voice and the time zone are choices, and the zone shows its time now', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Settings' }).click();
    const voice = page.getByLabel('Voice');
    await expect(voice).toHaveValue('marin');
    await expect(voice.locator('option:checked')).toHaveText('Marin (the default)');
    await expect(page.getByTestId('time-zone-value')).toContainText(/^America\/Denver, now \d{1,2}:\d{2} [AP]M$/);
    await page.getByRole('combobox', { name: 'Time zone' }).click();
    await page.getByPlaceholder('Search, like Madrid or New York').fill('madrid');
    await page.getByRole('option', { name: /Europe\/Madrid/ }).click();
    await expect(page.getByTestId('time-zone-value')).toContainText(/^Europe\/Madrid, now /);
    await page.close(); // not saved: the demo clinic keeps its zone
  });

  test('a saved time zone shows everywhere at once, without a reload', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Settings' }).click();
    const sidebar = page.getByRole('complementary');
    await expect(sidebar.getByText('America/Denver', { exact: true })).toBeVisible();
    const pick = async (search: string, zone: RegExp) => {
      await page.getByRole('combobox', { name: 'Time zone' }).click();
      await page.getByPlaceholder('Search, like Madrid or New York').fill(search);
      await page.getByRole('option', { name: zone }).click();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.locator('[aria-live=polite]').getByText('Saved. The next call uses these settings.')).toBeVisible();
    };
    await pick('madrid', /Europe\/Madrid/);
    await expect(sidebar.getByText('Europe/Madrid', { exact: true })).toBeVisible();
    await pick('denver', /America\/Denver/); // and back, for the specs after this one
    await expect(sidebar.getByText('America/Denver', { exact: true })).toBeVisible();
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
    // said in the page's toast, the live region with a surface of its own, so it can be read
    await expect(page.locator('[aria-live=polite]').getByText('Saved. The next call uses these settings.')).toBeVisible();
    await page.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByText('Changed clinic settings').first()).toBeVisible();
    await expect(page.getByText('Read a call transcript').first()).toBeVisible();
  });
});
