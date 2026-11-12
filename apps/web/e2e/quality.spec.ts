import { randomUUID } from 'node:crypto';
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

// A tester saw "No calls this week yet" while Calls listed that week's test calls. The page says what it left out,
// with the count the server sent, and opens those calls in Calls. Dates come from the server's week, not the test's clock.
test('the line about browser test calls says what the server counted, and opens them in Calls', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  const origin = { origin: new URL(page.url()).origin };
  // a browser test call this week (a simulated one, hung up at once), so there is one to leave out
  const started = await page.request.post(`/api/v1/clinics/${clinic}/test-calls/simulated`, { headers: origin });
  expect(started.ok()).toBe(true);
  const { callId } = await started.json() as { callId: string };
  // hung up the way the call bar does it
  expect((await page.request.post(`/api/v1/clinics/${clinic}/calls/${callId}/live/end`, { headers: origin, data: { key: randomUUID() } })).ok()).toBe(true);
  type Served = { weeks: { start: string; end: string; testCallsLeftOut: number }[] };
  const served = async () => await (await page.request.get(`/api/v1/clinics/${clinic}/quality?weeks=26`)).json() as Served;
  await expect.poll(async () => (await served()).weeks[0]!.testCallsLeftOut, { timeout: 20_000 }).toBeGreaterThan(0);
  const server = await served();
  const [week] = server.weeks;
  const n = week!.testCallsLeftOut;

  await page.goto(`/c/${clinic}/quality`);
  // the weeks since the demo clinic signed up, as many as the server sent
  await expect(page.locator('tbody tr')).toHaveCount(server.weeks.length);
  const line = page.getByTestId('quality-test-calls');
  await expect(line).toContainText(`${n} browser test call${n === 1 ? '' : 's'} this week ${n === 1 ? 'is' : 'are'} left out. Quality counts real phone calls only.`);
  await line.getByRole('link').click();
  await expect(page).toHaveURL(/\/calls\?.*channel=web/, { timeout: 20_000 });
  await expect(page.getByLabel('Channel')).toHaveValue('web');
  await expect(page.getByLabel('From')).toHaveValue(week!.start);
  await expect(page.getByLabel('To', { exact: true })).toHaveValue(week!.end);
  await expect(page.locator('tbody tr').first()).toBeVisible();
});

test('a week with only test calls says so, instead of a bare "No calls this week yet"', async ({ browser }) => {
  // this week as the server sends it, with its phone calls taken out and one test call left: the page's own wording is under test
  const page = await openAs(browser, 'manager', (p) => p.route((url) => url.pathname.startsWith('/api/v1/') && url.pathname.endsWith('/quality'), async (route) => {
    const res = await route.fetch();
    const body = await res.json() as { weeks: Record<string, unknown>[] };
    body.weeks[0] = { ...body.weeks[0], calls: 0, testCallsLeftOut: 1 };
    await route.fulfill({ response: res, json: body });
  }));
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/quality`);
  const line = page.getByTestId('quality-test-calls');
  await expect(line).toHaveText('No phone calls this week yet. 1 browser test call this week is left out. Quality counts real phone calls only. See it in Calls.');
  await expect(page.getByText('No calls this week yet.')).toHaveCount(0);
});

test('the front desk does not see Quality', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await expect(page.getByRole('link', { name: 'Quality' })).toHaveCount(0);
});

// No-shows are the desk's marks, counted by the server: the card and the week's row show the share and count it sent,
// and the card opens that week's visits on the schedule.
test('the no-shows card shows the server\'s share and count, and opens the week on the schedule', async ({ browser }) => {
  const page = await openAs(browser, 'manager', (p) => p.route((url) => url.pathname.startsWith('/api/v1/') && url.pathname.endsWith('/quality'), async (route) => {
    const res = await route.fetch();
    const body = await res.json() as { weeks: Record<string, unknown>[] };
    body.weeks[0] = { ...body.weeks[0], visitsDue: 8, noShows: 2, noShowShare: 0.25 };
    await route.fulfill({ response: res, json: body });
  }));
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/quality`);
  const card = page.getByTestId('quality-noShows');
  await expect(card).toContainText('No-shows');
  await expect(card).toContainText('25% (2)');
  await expect(card).toContainText('This week, 8 visits due');
  await expect(page.locator('tbody tr').first()).toContainText('25% (2)');
  await card.click();
  await expect(page).toHaveURL(/\/schedule\?.*view=agenda/, { timeout: 20_000 });
});

test('the no-shows card shows what the server counted, as it sent it', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  const served = await (await page.request.get(`/api/v1/clinics/${clinic}/quality?weeks=26`)).json() as { weeks: { noShows: number; noShowShare: number | null; visitsDue: number }[] };
  const [week] = served.weeks;
  await page.goto(`/c/${clinic}/quality`);
  const shown = week!.noShowShare === null ? '—' : `${Math.round(week!.noShowShare * 100)}% (${week!.noShows})`;
  await expect(page.getByTestId('quality-noShows').locator('p').nth(1)).toHaveText(shown);
  await expect(page.getByTestId('quality-noShows')).toContainText(`This week, ${week!.visitsDue} visit${week!.visitsDue === 1 ? '' : 's'} due`);
});

// Note 52 C11: "Turns to a booking 17" did not say what 17 counted. The card names it, says it in a line, and shows the
// server's own number (avgTurnsToBooking: the caller's turns, averaged over the week's booked or moved calls).
test('the caller-turns card says what it counts and shows the server\'s number', async ({ browser }) => {
  const page = await openAs(browser, 'manager', (p) => p.route((url) => url.pathname.startsWith('/api/v1/') && url.pathname.endsWith('/quality'), async (route) => {
    const res = await route.fetch();
    const body = await res.json() as { weeks: Record<string, unknown>[] };
    body.weeks[0] = { ...body.weeks[0], avgTurnsToBooking: 17, bookings: 3 };
    await route.fulfill({ response: res, json: body });
  }));
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/quality`);
  const card = page.getByTestId('quality-turns');
  await expect(card).toContainText('Caller turns per booking, average');
  await expect(card).toContainText('17');
  await expect(card).toContainText('Times the caller spoke, over 3 booked calls');
  await expect(page.getByText('Turns to a booking')).toHaveCount(0);
  // the week's row and the page's own words say the same
  await expect(page.getByRole('columnheader', { name: 'Caller turns per booking, average' })).toBeVisible();
  await page.getByText('What each number means').click();
  await expect(page.getByText('On calls that booked or moved a visit: how many times the caller spoke, start to end, on average.', { exact: false })).toBeVisible();

  // without the stand-in, the card shows what the server counted this week
  await page.unrouteAll();
  const served = await (await page.request.get(`/api/v1/clinics/${clinic}/quality?weeks=26`)).json() as { weeks: { avgTurnsToBooking: number | null }[] };
  await page.reload();
  const value = served.weeks[0]!.avgTurnsToBooking;
  await expect(page.getByTestId('quality-turns').locator('p').nth(1)).toHaveText(value === null ? '—' : String(value));
});
