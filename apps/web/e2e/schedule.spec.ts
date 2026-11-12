import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';
import { testDate, testNow } from './clock';

const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2];

/**
 * The week view, moved on a week at a time until a block matching `name` shows. With
 * `upcoming`, it starts next week, where every visit is still ahead and can be changed.
 */
async function findInWeek(page: Page, name: RegExp, upcoming = false) {
  // next week in the demo clinics' own time zone, not UTC: on a Sunday evening in Denver it is already Monday in UTC
  const nextWeek = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(testDate(7 * 86_400_000));
  await page.goto(`/c/${clinicOf(page)}/schedule?view=week${upcoming ? `&date=${nextWeek}` : ''}`);
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
    // whoever the call was from: each demo call books where it put the visit, for its own caller
    const name = (await block.getAttribute('aria-label'))!.split(', ')[1]!;
    await block.click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByText('By the assistant, on a call', { exact: false })).toBeVisible();
    await panel.getByRole('link', { name: 'Open the call and its transcript' }).click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/);
    // one date format across the dashboard, day first: the call's heading and its booking line alike
    await expect(page.getByRole('heading', { level: 1, name: /^\w+day \d{1,2} \w+ \d{4}, \d{1,2}:\d{2} [AP]M M[DS]T$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Booked: \w{3} \d{1,2} \w{3} \d{1,2}:\d{2} [AP]M with Dr\. / })).toBeVisible();
    await page.getByRole('link', { name, exact: true }).click(); // who was calling, verified
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible(); // a caller added on the call also says New
    await expect(page.getByText(/^(?:(?:Female|Male|Other|Prefers not to say), age|Age) \d+, born \d{1,2} [A-Z][a-z]+ \d{4}$/)).toBeVisible(); // with the gender first, when it is known
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
    await expect(page.locator('[aria-live=polite]').getByText('Moved. The schedule shows the new time.')).toBeVisible();
    await expect(panel.getByText(/^\w+day \d+ \w+, \d/)).not.toHaveText(before!);

    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByLabel('Why is it cancelled?').selectOption({ label: 'The patient asked' });
    await panel.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.locator('[aria-live=polite]').getByText('Cancelled. The time is free again.')).toBeVisible();
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

  test('New booking never offers a time sooner than the desk\'s lead, and says the grid and the lead the server sent', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.goto(`/c/${clinicOf(page)}/schedule`);
    await page.getByRole('button', { name: 'New booking' }).click();
    const dialog = page.getByRole('dialog', { name: 'New booking' });
    await dialog.getByLabel('Find a patient').fill('whit');
    // the open times this week, as the server sent them
    const loaded = page.waitForResponse((r) => /\/appointments\/slots\?/.test(r.url()) && r.ok());
    await dialog.getByRole('button', { name: /James Whitaker/ }).click();
    const server = await (await loaded).json() as { slots: { startsAt: string }[]; startEvery: number; leadMinutes: number };
    await expect(dialog.getByTestId('slot-grid')).toHaveText(`Start times every ${server.startEvery} minutes. Times starting in the next ${server.leadMinutes} minutes are not shown; for one sooner, use Override.`);
    // every time shown starts at least the lead time from now, on the suite's clock (E2E_CLOCK)
    const shown = await dialog.getByRole('radio').evaluateAll((els) => els.map((e) => e.getAttribute('data-starts-at')!));
    const earliest = testNow() + server.leadMinutes * 60_000;
    expect(shown.filter((t) => new Date(t).getTime() < earliest)).toEqual([]);
    // with anyone: each time once a day, the providers free at it as the choices (note 52 C6)
    const rows = dialog.getByTestId('slot-rows').first();
    const times = await rows.locator(':scope > li > span').allTextContents();
    expect(times.length).toBeGreaterThan(0);
    expect(new Set(times).size).toBe(times.length);
    const firstTime = times[0]!;
    await expect(rows.locator(':scope > li').first().getByRole('radio').first()).toHaveAccessibleName(new RegExp(`^${firstTime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} with `));
  });

  test('N opens New booking on the Schedule itself, again after the dialog is closed', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.goto(`/c/${clinicOf(page)}/schedule`);
    // the page may still be compiling under next dev on a busy CI runner: give it the time the other first loads get
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
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
    // the page may still be compiling under next dev on a busy CI runner: give it the time the other first loads get
    await expect(page.getByText('A cancelled visit is hidden. Choose Booked and cancelled to see it.')).toBeVisible({ timeout: 30_000 });
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
    // the week's title changes when the later week is shown: only then are its times the ones to pick from
    const week = dialog.getByRole('button', { name: 'Later week' }).locator('xpath=preceding-sibling::p');
    const thisWeek = await week.textContent();
    await dialog.getByRole('button', { name: 'Later week' }).click();
    await expect(week).not.toHaveText(thisWeek ?? '');
    await dialog.getByRole('radio').first().click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click(); // past the note
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    const refused = page.getByRole('dialog', { name: 'Not booked' });
    await expect(refused.getByText('The booking was not saved: that time is outside the provider\'s hours.')).toBeVisible();
    await expect(refused.getByText(/Check your connection/)).toHaveCount(0);
  });

  test('a visit cancelled from the panel stays on the week, marked cancelled, until the panel closes', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    const block = await findInWeek(page, /booked by the assistant/, true);
    const label = (await block.getAttribute('aria-label'))!;
    await block.click();
    const panel = page.getByRole('dialog');
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByLabel('Why is it cancelled?').selectOption({ label: 'The patient asked' });
    await panel.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.locator('[aria-live=polite]').getByText('Cancelled. The time is free again.')).toBeVisible();
    // the week hides cancelled visits, but not the one open in the panel
    const cancelled = page.locator(`[data-testid=appointment][aria-label="${label.replace(', booked by', ', cancelled, booked by')}"]`);
    await expect(cancelled).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(cancelled).toHaveCount(0);
    await expect(page.getByText(/\d+ booked, \d+ cancelled hidden/)).toBeVisible();
  });

  test('the call behind a booking staff cancelled says so, in its header and on the booking', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    const block = await findInWeek(page, /booked by the assistant/, true);
    await block.click();
    const panel = page.getByRole('dialog');
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByLabel('Why is it cancelled?').selectOption({ label: 'The patient asked' });
    await panel.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.locator('[aria-live=polite]').getByText('Cancelled. The time is free again.')).toBeVisible();
    await panel.getByRole('link', { name: 'Open the call and its transcript' }).click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/);
    await expect(page.getByText('Booking since cancelled')).toBeVisible();
    await expect(page.getByText('Since cancelled', { exact: true })).toBeVisible();
  });
});

// The desk marks what happened to a visit from its panel (SCH-1): a key on a keyboard, a button on a phone. Each state
// is one the server allows now; the block on the grid says it.
test('one status default in every view (booked only), and a US clinic\'s month and week both start on Sunday', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = clinicOf(page);
  for (const view of ['day', 'week', 'month', 'agenda']) {
    await page.goto(`/c/${clinic}/schedule?view=${view}`);
    await expect(page.locator('#schedule-show'), view).toHaveValue('booked');
  }
  // the demo clinic is in the US (+1): Sunday first, as its own calendars count
  await page.goto(`/c/${clinic}/schedule?view=month`);
  await expect(page.getByRole('columnheader')).toHaveText(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  const first = await page.getByTestId('month-day').first().getAttribute('aria-label');
  expect(first).toMatch(/^Sunday /);
  // the Week view starts on the same day (note 52 C7): seven days from Sunday, a closed weekend day kept as a narrow
  // "Closed" column, never a week that starts on Monday beside a month that starts on Sunday
  await page.goto(`/c/${clinic}/schedule?view=week`);
  await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { level: 2, name: /^Week of Sunday \d{1,2} \w+$/ })).toBeVisible();
  const days = page.locator('[data-testid="week-day"], [data-testid="week-day-closed"]');
  await expect(days).toHaveCount(7);
  await expect(days.first()).toContainText(/^Sun \d{1,2} \w{3}/);
  await expect(days.last()).toContainText(/^Sat \d{1,2} \w{3}/);
});

// Note 52 C7: the Day view's first hour had no label, so the first visit sat beside an empty hour column.
test('the Day view labels its first hour, under the headings, beside the first visit', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.goto(`/c/${clinicOf(page)}/schedule?view=day`);
  await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
  const labels = page.getByTestId('hour-label');
  await expect(labels.first()).toHaveText(/^\d{1,2} [AP]M$/);
  // one label per hour of the grid, the first one included, in order
  const texts = await labels.allTextContents();
  const hours = texts.map((t) => { const [h, m] = t.split(' '); return (Number(h) % 12) + (m === 'PM' ? 12 : 0); });
  expect(hours).toEqual(hours.map((_, i) => hours[0]! + i));
  // whole: below the lane headings, not cut by them, and level with the top of the grid where the first hour starts
  const head = (await page.getByTestId('lane-head').first().boundingBox())!;
  const label = (await labels.first().boundingBox())!;
  expect(label.y).toBeGreaterThanOrEqual(head.y + head.height - 0.5);
  expect(label.y).toBeLessThan(head.y + head.height + 12);
});

test('the desk marks a visit arrived with a key, the grid says so, and puts it back to booked on a phone', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = clinicOf(page);
  const origin = { origin: new URL(page.url()).origin };
  const found = await (await page.request.post(`/api/v1/clinics/${clinic}/patients/search`, { headers: origin, data: { query: 'whit' } })).json() as { patients: { id: string; name: string }[] };
  const james = found.patients.find((p) => p.name === 'James Whitaker')!;
  // a few minutes from now, squeezed in with Override: a visit of today in the clinic's time, still ahead, so no-show is
  // not offered yet. A fixed 23:30 had passed on a run at 23:39 Denver time; in the last minutes of the clinic's day the
  // test waits for its midnight, so the visit is always ahead and always on the day the desk marks it
  const denverDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(d);
  const startOf = () => new Date(Math.ceil((testNow() + 3 * 60_000) / 60_000) * 60_000);
  if (denverDay(startOf()) !== denverDay(testDate())) {
    test.setTimeout(test.info().timeout + 4 * 60_000);
    await page.waitForTimeout(startOf().getTime() - testNow() + 1000);
  }
  // the demo day has visits of its own: in clinic hours "a few minutes from now" may be taken, so the first free
  // start from then on, in 15-minute steps, still today in the clinic's time
  const first = startOf();
  const today = denverDay(first);
  let booked = null as Awaited<ReturnType<typeof page.request.post>> | null;
  for (let step = 0; ; step++) {
    const at = new Date(first.getTime() + step * 15 * 60_000);
    if (denverDay(at) !== today) break;
    booked = await page.request.post(`/api/v1/clinics/${clinic}/appointments`, { headers: origin, data: {
      patientId: james.id, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: at.toISOString(), idempotencyKey: `e2e-mark-${testNow()}-${step}`,
      override: true, overrideReason: 'late check',
    } });
    if (booked.status() !== 409) break;
  }
  expect(booked, 'no free start left today').not.toBeNull();
  expect(booked!.status(), await booked!.text()).toBe(201);
  const { appointmentId } = await booked!.json() as { appointmentId: string };
  await page.goto(`/c/${clinic}/schedule?view=day&date=${today}&appointment=${appointmentId}`);
  const panel = page.getByRole('dialog', { name: 'James Whitaker' });
  await expect(panel.getByRole('group', { name: 'Mark the visit' })).toBeVisible();
  await expect(panel.getByTestId('mark-no_show')).toBeDisabled();
  await page.keyboard.press('a');
  await expect(panel.getByTestId('visit-marked')).toContainText('Arrived');
  await expect(panel.getByTestId('visit-marked')).toContainText('by Jordan');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid=appointment][aria-label*="James Whitaker"][aria-label*=", arrived"]').first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/c/${clinic}/schedule?view=day&date=${today}&appointment=${appointmentId}`);
  const onPhone = page.getByRole('dialog', { name: 'James Whitaker' });
  await onPhone.getByRole('button', { name: /Back to booked/ }).click();
  await expect(page.locator('[aria-live=polite]').getByText('Back to booked.')).toBeVisible();
  await expect(onPhone.getByTestId('visit-marked')).toHaveCount(0);
  await expect(onPhone.getByTestId('mark-arrived')).toBeEnabled();
});
