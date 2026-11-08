// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { openAs } from './session';

// Note 15, the field standard (docs/field-standard.md): each label reaches its field, limits match the server's, an
// error is read with its field, and a day that makes no sense is refused with what to pick. Nothing here is saved.

test('Settings: labels reach their fields, a past holiday is refused with what to pick, the clinic\'s name is not filled from the browser', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings`);
  await expect(page.getByLabel('Clinic name')).toHaveAttribute('autocomplete', 'off');
  await expect(page.getByLabel('Clinic name')).toHaveAttribute('maxlength', '100');
  // one id on the page for each field: the label and its hint reach the input, not a wrapper around it
  expect(await page.locator('[id]').evaluateAll((els) => { const ids = els.map((e) => e.id); return ids.filter((id, i) => ids.indexOf(id) !== i); })).toEqual([]);

  const holiday = page.getByLabel('Holiday date');
  await holiday.fill('2020-01-01');
  await expect(page.getByText('Pick today or a day to come.')).toBeVisible();
  await expect(holiday).toHaveAttribute('aria-invalid', 'true');
  await expect(holiday).toHaveAttribute('aria-describedby', 'holiday-past');
  await expect(page.getByRole('button', { name: 'Add holiday' })).toBeDisabled();
  await holiday.fill('');
  await expect(page.getByText('Pick today or a day to come.')).toHaveCount(0);
});

test('Texting: the quiet hours label reaches its field, reminder hours take what the server takes', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings/texting`);
  const reminders = page.getByRole('switch', { name: 'Send appointment reminders' });
  if ((await reminders.getAttribute('aria-checked')) !== 'true') await reminders.click();
  await expect(page.getByLabel('Quiet hours', { exact: true })).toHaveAttribute('type', 'time');
  await expect(page.getByLabel('Hours before the visit')).toHaveAttribute('min', '2');
  await expect(page.getByLabel('Hours before the visit')).toHaveAttribute('max', '168');
});

test('Integrations: the endpoint address is a web address field with the server\'s limit', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings/integrations`);
  const url = page.getByLabel('URL');
  await expect(url).toHaveAttribute('type', 'url');
  await expect(url).toHaveAttribute('maxlength', '2000');
  await expect(url).toHaveAttribute('autocomplete', 'off');
});

test('Team: an address that is not an email is said under the box and read with it', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/team`);
  await page.getByRole('button', { name: 'Add people' }).click();
  const emails = page.getByLabel('Emails');
  await emails.fill('riley@example.com\nnot an address');
  await expect(page.getByText('Not an email address: not an address')).toBeVisible();
  await expect(emails).toHaveAttribute('aria-invalid', 'true');
  await expect(emails).toHaveAttribute('aria-describedby', 'people-emails-hint people-emails-error');
});
