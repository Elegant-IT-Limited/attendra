import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2];

/** The week view, moved on a week at a time until a block matching `name` shows. */
async function findInWeek(page: Page, name: RegExp) {
  await page.goto(`/c/${clinicOf(page)}/schedule?view=week`);
  const block = page.getByTestId('appointment').and(page.getByRole('button', { name }));
  const heading = page.getByRole('heading', { level: 2, name: /^Week of / });
  for (let week = 0; week < 3; week++) {
    // the grid keeps the previous week on screen until the next one arrives, so wait for this one
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('lane').first()).toBeVisible();
    if (await block.count()) return block.first();
    // straight after the click the old week is still on screen and not yet busy: wait for the new heading first
    const before = await heading.textContent();
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(heading).not.toHaveText(before!);
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
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
    // one date format across the dashboard, day first: the call's heading and its booking line alike
    await expect(page.getByRole('heading', { level: 1, name: /^\w+day \d{1,2} \w+ \d{4}, \d{1,2}:\d{2} [AP]M M[DS]T$/ })).toBeVisible();
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

  test('a visit too short for two lines shows its time on the first', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.goto(`/c/${clinicOf(page)}/schedule?view=week`);
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
    // a 20 minute sick visit is one line high
    const block = page.locator('[data-testid=appointment][aria-label*="sick visit"]').first();
    const [time, name] = (await block.getAttribute('aria-label'))!.split(', ');
    await expect(block).toContainText(`${name} · ${time}`);
  });

  test('N opens New booking on the Schedule itself, again after the dialog is closed', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.goto(`/c/${clinicOf(page)}/schedule`);
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
    const dialog = page.getByRole('dialog', { name: 'New booking' });
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('n');
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page).not.toHaveURL(/new=1/); // closing clears it, so the next N is a change again
    }
  });

  test('a week with only cancelled visits says they are hidden, not that nothing was booked', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.route((u) => u.pathname.endsWith('/appointments') && u.searchParams.has('from'), (route) => {
      const from = new URL(route.request().url()).searchParams.get('from')!;
      const at = new Date(`${from}T16:00:00Z`);
      route.fulfill({ json: { from, days: 7, appointments: [{
        id: 'appt_hidden', patientId: 'p1', patientName: 'Sam Rivera', providerId: 'prov_okafor', visitTypeId: 'vt_sick',
        startsAt: at.toISOString(), endsAt: new Date(at.getTime() + 20 * 60_000).toISOString(), status: 'cancelled', cancelReason: 'patient_asked',
        bookedBy: { kind: 'staff', name: 'Jordan (front desk)' }, cancelledBy: { kind: 'staff', name: 'Jordan (front desk)' }, createdAt: at.toISOString(),
      }] } });
    });
    await page.goto(`/c/${clinicOf(page)}/schedule?view=week`);
    await expect(page.getByText('A cancelled visit is hidden. Tick Show cancelled to see it.')).toBeVisible();
    await expect(page.getByText('Nothing booked here yet')).toHaveCount(0);
  });

  test('a booking the server refuses says why, not that the connection failed', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.goto(`/c/${clinicOf(page)}/schedule?view=week`);
    await expect(page.getByTestId('lane').first()).toBeVisible();
    await page.route((u) => u.pathname.endsWith('/appointments'), (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 422, json: { error: 'invalid_request', issues: [{ path: 'startsAt', message: 'that time is outside the provider\'s hours' }] } })
      : route.fallback()));
    await page.getByRole('button', { name: 'New booking' }).click();
    const dialog = page.getByRole('dialog', { name: 'New booking' });
    await dialog.getByLabel('Find a patient').fill('whit');
    await dialog.getByRole('button', { name: /James Whitaker/ }).click();
    await dialog.getByLabel('Visit type').selectOption({ label: 'Annual physical (40 min)' });
    await dialog.getByLabel('Provider').selectOption({ label: 'Dr. Nkem Okafor' });
    await dialog.getByRole('button', { name: 'Later week' }).click();
    await dialog.getByRole('radio').first().click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click(); // past the note
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog.getByText('The booking was not saved: that time is outside the provider\'s hours.')).toBeVisible();
    await expect(dialog.getByText(/Check your connection/)).toHaveCount(0);
  });

  test('a visit cancelled from the panel stays on the week, marked cancelled, until the panel closes', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    const block = await findInWeek(page, /booked by the assistant/);
    const label = (await block.getAttribute('aria-label'))!;
    await block.click();
    const panel = page.getByRole('dialog');
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByLabel('Why is it cancelled?').selectOption({ label: 'The patient asked' });
    await panel.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(panel.getByText('Cancelled. The time is free again.')).toBeVisible();
    // the week hides cancelled visits, but not the one open in the panel
    const cancelled = page.locator(`[data-testid=appointment][aria-label="${label.replace(', booked by', ', cancelled, booked by')}"]`);
    await expect(cancelled).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(cancelled).toHaveCount(0);
    await expect(page.getByText(/\d+ booked, \d+ cancelled hidden/)).toBeVisible();
  });

  test('the call behind a booking staff cancelled says so, in its header and on the booking', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    const block = await findInWeek(page, /booked by the assistant/);
    await block.click();
    const panel = page.getByRole('dialog');
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByLabel('Why is it cancelled?').selectOption({ label: 'The patient asked' });
    await panel.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(panel.getByText('Cancelled. The time is free again.')).toBeVisible();
    await panel.getByRole('link', { name: 'Open the call and its transcript' }).click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/);
    await expect(page.getByText('Booking since cancelled')).toBeVisible();
    await expect(page.getByText('Since cancelled', { exact: true })).toBeVisible();
  });
});
