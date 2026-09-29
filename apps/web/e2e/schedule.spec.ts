import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2];

/** The week view, moved on a week at a time until a block matching `name` shows. */
async function findInWeek(page: Page, name: RegExp) {
  await page.goto(`/c/${clinicOf(page)}/schedule?view=week`);
  const block = page.getByTestId('appointment').and(page.getByRole('button', { name }));
  for (let week = 0; week < 3; week++) {
    // the grid keeps the previous week on screen until the next one arrives, so wait for this one
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('lane').first()).toBeVisible();
    if (await block.count()) return block.first();
    await page.getByRole('button', { name: 'Next week' }).click();
  }
  throw new Error(`no appointment matching ${name} in the next three weeks`);
}

test.describe.serial('the schedule', () => {
  test('front desk opens Today, then the Schedule; follows a booking the assistant made to its call, then to the patient', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Schedule', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
    await expect(page.getByText(/Times are .*America\/Denver/)).toBeVisible();
    const block = await findInWeek(page, /booked by the assistant/);
    await block.click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByText('By the assistant, on a call', { exact: false })).toBeVisible();
    await panel.getByRole('link', { name: 'Open the call and its transcript' }).click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/);
    await expect(page.getByRole('link', { name: /^Booked: \w{3} \d{1,2} \w{3} \d{1,2}:\d{2} [AP]M with Dr\. / })).toBeVisible();
    await page.getByRole('link', { name: 'Maria Delgado' }).click(); // who was calling, verified
    await expect(page.getByRole('heading', { name: 'Maria Delgado' })).toBeVisible();
    await expect(page.getByText(/^Age \d+, born 4 March 1985$/)).toBeVisible();
    await page.getByRole('tab', { name: /Calls/ }).click();
    await expect(page.getByRole('link', { name: /Transcript/ }).first()).toBeVisible();
  });

  test('front desk books, sees it on the schedule, moves it, then cancels it', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.goto(`/c/${clinicOf(page)}/schedule?view=week`);
    await expect(page.getByTestId('lane').first()).toBeVisible();
    await page.getByRole('button', { name: 'New booking' }).click();
    const dialog = page.getByRole('dialog', { name: 'New booking' });
    const name = 'James Whitaker';
    await dialog.getByLabel('Find a patient').fill('whit');
    await dialog.getByRole('button', { name: /James Whitaker/ }).click();
    await dialog.getByLabel('Visit type').selectOption({ label: 'Annual physical (40 min)' });
    await dialog.getByLabel('Provider').selectOption({ label: 'Dr. Nkem Okafor' });
    await dialog.getByRole('button', { name: 'Later week' }).click(); // next week has room whatever the time now
    await dialog.getByRole('radio').first().click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByLabel(/Note for the team/).fill('Fasting blood work at the same visit.');
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(dialog.getByText(name, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Book appointment' }).click();

    const panel = page.getByRole('dialog', { name });
    await expect(panel.getByText('Fasting blood work at the same visit.')).toBeVisible();
    await expect(panel.getByText(/By Jordan \(front desk\)/)).toBeVisible();
    // the open panel is modal, so the grid behind it is out of the accessibility tree
    await expect(page.locator(`[data-testid=appointment][aria-label*="${name}, annual physical, booked by staff"]`).first()).toBeVisible();
    const before = await panel.getByText(/^\w+day \d+ \w+, \d/).textContent();

    await panel.getByRole('button', { name: 'Reschedule' }).click();
    // two weeks out: clear of the week it was just booked in
    await panel.getByRole('button', { name: 'Later week' }).click();
    await panel.getByRole('button', { name: 'Later week' }).click();
    await panel.getByRole('radio').first().click();
    await panel.getByRole('button', { name: 'Move appointment' }).click();
    await expect(panel.getByText('Moved. The schedule shows the new time.')).toBeVisible();
    await expect(panel.getByText(/^\w+day \d+ \w+, \d/)).not.toHaveText(before!);

    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByLabel('Why is it cancelled?').selectOption({ label: 'The patient asked' });
    await panel.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(panel.getByText('Cancelled. The time is free again.')).toBeVisible();
    await expect(panel.getByText('The patient asked, by Jordan (front desk).')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
});
