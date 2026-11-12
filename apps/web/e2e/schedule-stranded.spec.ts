import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { testDate } from './clock';
import { openAs } from './session';

/**
 * A change of hours that would strand booked visits is never silent (SCH-4): a holiday added on a day the demo has
 * visits shows the "move or keep" list before anything is saved (when, with whom, the patient as the schedule names
 * them), each Move opens that visit's reschedule, Go back saves nothing, and Keep saves with the visits left where
 * they are, the Schedule's warning then counting them. The holiday comes off again at the end, for the specs after.
 */
const ZONE = 'America/Denver';
const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(d);

test('a holiday over booked visits asks "move or keep" first: Go back saves nothing, Move opens the reschedule, Keep saves and the Schedule warns', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2]!;
  // a day from tomorrow with booked visits (the demo books three weeks from this Monday), and how many
  const from = localDate(testDate(86_400_000));
  const booked = await page.evaluate(async ({ id, from }) => {
    const res = await (await fetch(`/api/v1/clinics/${id}/appointments?from=${from}&days=7&status=booked`)).json();
    return res.appointments as { id: string; startsAt: string; patientName: string; overrideReason: string | null }[];
  }, { id: clinic, from });
  const onDay = (date: string) => booked.filter((a) => localDate(new Date(a.startsAt)) === date && !a.overrideReason);
  const day = [...new Set(booked.map((a) => localDate(new Date(a.startsAt))))].find((d) => onDay(d).length > 0)!;
  expect(day, 'the demo has a booked day this week').toBeTruthy();
  const visits = onDay(day);
  const settingsHolidays = () => page.evaluate(async (id) => (await (await fetch(`/api/v1/clinics/${id}/settings`)).json()).holidays as string[], clinic);

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Holiday date').fill(day);
  await page.getByRole('button', { name: 'Add holiday' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  const dialog = page.getByRole('dialog', { name: `${visits.length} booked ${visits.length === 1 ? 'visit' : 'visits'} would be left outside the hours` });
  await expect(dialog).toBeVisible();
  const rows = dialog.getByTestId('stranded-visits').getByRole('listitem');
  await expect(rows).toHaveCount(visits.length);
  await expect(dialog).toContainText(visits[0]!.patientName);
  await expect(rows.first()).toContainText('the clinic would be closed');
  // each Move is that visit's reschedule, in a new tab so this change is not lost
  const move = rows.first().getByRole('link', { name: /^Move / });
  await expect(move).toHaveAttribute('target', '_blank');
  const href = (await move.getAttribute('href'))!;
  expect(href).toMatch(/[?&]move=1/);
  expect(href).toMatch(/[?&]appointment=/);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).include('[role=dialog]').analyze();
  expect(result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  // Go back: nothing saved, the change still on the page
  await dialog.getByRole('button', { name: 'Go back' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('You have unsaved changes.')).toBeVisible();
  expect(await settingsHolidays()).not.toContain(day);

  // Move opens the visit's panel on Reschedule
  const tab = await page.context().newPage();
  await tab.goto(href);
  await expect(tab.getByRole('dialog').getByText('Pick a new time.', { exact: false })).toBeVisible({ timeout: 30_000 });
  await tab.close();

  // Keep: saved, the visits as they were, and the warning counts them
  await page.getByRole('button', { name: 'Save changes' }).click();
  await dialog.getByRole('button', { name: /^Keep (it|them) and save$/ }).click();
  await expect(page.locator('[aria-live=polite]').getByText('Saved. The next call uses these settings.')).toBeVisible();
  expect(await settingsHolidays()).toContain(day);
  await page.getByRole('link', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText(/booked visits? (is|are) on a day off, a holiday or outside the hours/)).toBeVisible();

  // and off again: taking a holiday away strands nothing, so it saves straight away
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: `Remove ${day}` }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  // the newest note: the one from the save before may still be showing (notes no longer cover the Save button)
  await expect(page.locator('[aria-live=polite]').getByText('Saved. The next call uses these settings.').last()).toBeVisible();
  expect(await settingsHolidays()).not.toContain(day);
});
