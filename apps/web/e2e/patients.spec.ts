import { expect, test } from '@playwright/test';
import { openAs } from './session';

test.describe.serial('patients', () => {
  test('search finds Maria Delgado by name and by date of birth', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.getByRole('link', { name: 'Patients' }).click();
    const search = page.getByLabel('Find a patient');
    const results = page.getByRole('list', { name: 'Matching patients' });
    await search.fill('delg');
    await expect(results.getByRole('link', { name: /Maria Delgado/ })).toBeVisible();
    await search.fill('03/04/1985');
    await expect(results.getByRole('link')).toHaveCount(1);
    await expect(results.getByRole('link', { name: /Maria Delgado/ })).toBeVisible();
    await search.fill('March 4 1985');
    await expect(results.getByRole('link', { name: /Maria Delgado/ })).toBeVisible();
    await expect(page).not.toHaveURL(/1985|delg/i); // what was typed never reaches the address bar
    await results.getByRole('link', { name: /Maria Delgado/ }).click();
    await expect(page.getByRole('heading', { name: 'Maria Delgado' })).toBeVisible();
  });

  test('front desk adds a patient, then books them', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.getByRole('link', { name: 'Patients' }).click();
    await page.getByRole('button', { name: 'Add patient' }).click();
    const form = page.getByRole('dialog', { name: 'Add patient' });
    await form.getByLabel('First name').fill('Tessa');
    await form.getByLabel('Last name').fill('Okoro');
    await form.getByLabel('Date of birth').fill('1993-02-11');
    await form.getByLabel(/Phone/).fill('(720) 555-0188');
    await form.getByRole('button', { name: 'Add patient' }).click();

    await expect(page.getByRole('heading', { name: 'Tessa Okoro' })).toBeVisible();
    await expect(page.getByText('No appointments yet')).toBeVisible();
    await page.getByRole('button', { name: 'Book' }).click();
    const dialog = page.getByRole('dialog', { name: 'New booking' });
    await expect(dialog.getByText('For Tessa Okoro')).toBeVisible();
    await dialog.getByLabel('Visit type').selectOption({ label: 'New patient visit (60 min)' });
    await dialog.getByRole('button', { name: 'Later week' }).click();
    await dialog.getByRole('radio').first().click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/New patient visit with Dr\. Nkem Okafor/)).toBeVisible();
    await expect(page.getByText('Upcoming')).toBeVisible();

    // and the new patient is findable by the phone number on file
    await page.getByRole('link', { name: 'Patients', exact: true }).first().click();
    await page.getByLabel('Find a patient').fill('720 555 0188');
    await expect(page.getByRole('list', { name: 'Matching patients' }).getByRole('link', { name: /Tessa Okoro/ })).toBeVisible();
  });
});
