import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openAs } from './session';

test.describe.serial('the front desk, end to end on the demo clinic', () => {
  test('a manager sees the week of calls', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Calls' })).toBeVisible();
    await expect(page.getByText('Demo mode.')).toBeVisible();
    // 33 eval scenarios in the weeks before, and 11 ordinary calls this week
    await expect(page.locator('tbody tr')).toHaveCount(44);
    // named for what it holds; Today's Needs attention is a different, wider list
    await expect(page.getByRole('tab', { name: 'Needs attention' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Emergencies and requests' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(9); // 6 requests for staff, 3 emergencies
  });

  test('the call list says what the assistant did in call order, and how each confirmation ended', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    const did = (row: import('@playwright/test').Locator) => row.locator('td').nth(3);
    // the caller who was not sure yet: a time was proposed, and nothing was booked
    await expect(did(page.locator('tbody tr').filter({ hasText: 'Daniel Okonkwo' }))).toHaveText('Identity check, Searched openings, Proposed a time, No clear yes');
    const booked = page.locator('tbody tr').filter({ has: page.getByText('Booked', { exact: true }) }).first();
    await expect(did(booked)).toHaveText(/^Identity check, .*, Booked$/);
    // a confirm sent again after the cancellation changed nothing, so the list leaves it out
    await expect(did(page.locator('tbody tr').filter({ hasText: 'Proposed a cancellation, Cancelled' }))).toHaveText('Identity check, Looked up appointments, Proposed a cancellation, Cancelled');
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
    const tasks = page.getByTestId('task-row');
    // 5 from the eval calls, a refill and a callback from this week's, 3 urgent checks for the emergency calls (every emergency
    // opens one, 2026-10-24), and follow-ups for flagged calls: one to three, because a second call from the same number joins
    // its open one, and how close those calls fall depends on when the suite runs (11 or 13 in all)
    await expect.poll(() => tasks.count()).toBeGreaterThanOrEqual(11);
    const open = await tasks.count();
    expect(open).toBeLessThanOrEqual(13);
    // his refill card: newest first, so it is no longer at the top, and he has other requests now (an urgent check, a follow-up)
    const row = tasks.filter({ hasText: 'James Whitaker' }).filter({ hasText: 'Prescription refill' });
    await expect(row).toHaveCount(1);
    // the row opens the request in the side panel, where the actions are
    await row.click();
    const first = page.getByTestId('task');
    await expect(first.getByText('James Whitaker').first()).toBeVisible();
    await first.getByRole('button', { name: 'Claim' }).click();
    await expect(first.getByText('You have it')).toBeVisible();
    await first.getByRole('button', { name: 'Release' }).click();
    await expect(first.getByText('Unclaimed')).toBeVisible();
    await first.getByRole('button', { name: 'Claim' }).click();
    await first.getByRole('button', { name: 'Mark done' }).click();
    await first.getByLabel('Outcome').selectOption({ label: 'Called back' });
    await first.getByRole('button', { name: 'Mark done' }).click();
    await expect(tasks).toHaveCount(open - 1);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
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

  test('on a phone the account menu is the header\'s alone, and a wide table scrolls with the keyboard and shows an edge', async ({ browser }) => {
    test.slow();
    const page = await openAs(browser, 'manager');
    const clinic = new URL(page.url()).pathname.split('/')[2];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/c/${clinic}/audit`);
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    // the sidebar and its account button are gone below the tablet width: nothing sits over the bottom bar's Today tab
    const account = 'button[aria-label$="account and theme"]';
    await expect(page.locator('aside').locator(account)).toBeHidden();
    const header = page.locator('header').locator(account);
    await expect(header).toBeVisible();
    expect((await header.boundingBox())!.y).toBeLessThan(80);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Today' })).toBeVisible();
    // the audit log's table is wider than the screen: a named region the keyboard reaches, with an edge that says there is more
    const axe = async (where: string) => {
      const result = await new AxeBuilder({ page }).withRules(['scrollable-region-focusable', 'document-title']).exclude('nextjs-portal').analyze();
      expect(result.violations.map((v) => v.id), where).toEqual([]);
    };
    const region = page.getByRole('region', { name: 'Audit log' });
    await expect(region).toHaveAttribute('tabindex', '0');
    await expect(region.locator('..').getByTestId('scroll-edge-right')).toHaveCSS('opacity', '1');
    await region.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect(region.locator('..').getByTestId('scroll-edge-left')).toHaveCSS('opacity', '1');
    await axe('Audit log');
    for (const [path, name] of [['/team', 'Team'], ['/calls', 'Calls']] as const) {
      await page.goto(`/c/${clinic}${path}`);
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name })).toBeVisible();
      await axe(name);
    }
    // Fields and lists has the page title like every page, and its tab strip scrolls the same way
    await page.goto(`/c/${clinic}/settings/fields`);
    await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();
    await expect(page).toHaveTitle(/Attendra/);
    await expect(page.getByRole('region', { name: 'Settings pages' })).toHaveAttribute('tabindex', '0');
    await axe('Fields and lists');
    await page.close();
  });

  test('every tab list has a name, and its panel is named by the selected tab', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    const clinic = new URL(page.url()).pathname.split('/')[2];
    for (const [path, list, tab] of [['calls', 'Which calls', 'All calls'], ['schedule', 'View', 'Day']] as const) {
      await page.goto(`/c/${clinic}/${path}`);
      await expect(page.getByRole('tablist', { name: list })).toBeVisible();
      await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
    }
    // a filter switch with no panels of its own (Requests' Open / Done, like Pets') is a named group of pressed buttons
    await page.goto(`/c/${clinic}/requests`);
    await expect(page.getByRole('group', { name: 'Status' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'true');
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

  test('the unsaved-changes bar starts where the sidebar ends', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('Holiday date').fill('2027-01-01'); // a change, not saved
    await page.getByRole('button', { name: 'Add holiday' }).click();
    for (const width of [1440, 900]) { // the full sidebar, then the narrow one
      await page.setViewportSize({ width, height: 800 });
      const aside = (await page.locator('aside').boundingBox())!;
      const bar = page.getByText('You have unsaved changes.').locator('xpath=../..');
      await expect.poll(async () => (await bar.boundingBox())?.x).toBe(aside.x + aside.width);
    }
    await page.close();
  });

  test('a saved time zone shows everywhere at once, without a reload', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    // the schedule says whose times it shows; the sidebar shows the person's role, not the zone
    const zoneOnSchedule = async (zone: string) => {
      await page.getByRole('link', { name: 'Schedule', exact: true }).click();
      await expect(page.getByText(`(${zone}).`, { exact: false })).toBeVisible();
      await page.getByRole('link', { name: 'Settings' }).click();
    };
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByTestId('time-zone-value')).toContainText(/^America\/Denver/);
    const pick = async (search: string, zone: RegExp) => {
      await page.getByRole('combobox', { name: 'Time zone' }).click();
      await page.getByPlaceholder('Search, like Madrid or New York').fill(search);
      await page.getByRole('option', { name: zone }).click();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.locator('[aria-live=polite]').getByText('Saved. The next call uses these settings.')).toBeVisible();
    };
    await pick('madrid', /Europe\/Madrid/);
    await zoneOnSchedule('Europe/Madrid');
    await pick('denver', /America\/Denver/); // and back, for the specs after this one
    await zoneOnSchedule('America/Denver');
  });

    test('a greeting that hides the AI is refused; a holiday saves and is audited', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Settings' }).click();
    const greeting = page.getByLabel('Greeting');
    const original = await greeting.inputValue();
    await greeting.fill('Thanks for calling Maple Street. How can I help?');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('dialog', { name: 'Not saved. Fix these first' }).getByText('the greeting must disclose that the caller is speaking with an AI assistant')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
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

  test('settings say which sections callers never hear about; a doctor\'s own field is told to callers unless it is kept for the team', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.getByRole('link', { name: 'Settings' }).click();
    const line = 'For your team only. The assistant does not read this to callers.';
    await expect(page.locator('#links').getByTestId('team-only')).toHaveText(line);
    await page.getByRole('link', { name: 'Requests and kinds of request' }).click();
    await expect(page.locator('#request-fields').getByTestId('team-only')).toHaveText(line);
    await page.getByRole('tab', { name: /Doctors|Veterinarians/ }).click();
    const fields = page.locator('#provider-fields');
    await expect(fields.getByTestId('team-only')).toHaveCount(0);
    await fields.getByRole('button', { name: 'Field', exact: true }).click();
    const tell = fields.getByRole('checkbox', { name: 'The assistant may tell callers' });
    await expect(tell).toBeChecked();
    await tell.click();
    await expect(tell).not.toBeChecked();
    await page.close(); // nothing saved
  });
});
