import { expect, test } from '@playwright/test';
import { openAs } from './session';

test('a manager adds a doctor with hours and days off, and the front desk sees them without a refresh', async ({ browser }) => {
  const desk = await openAs(browser, 'frontdesk');
  await desk.getByRole('link', { name: 'Doctors' }).click();
  await expect(desk.getByRole('heading', { name: 'Doctors' })).toBeVisible();
  await expect(desk.getByTestId('doctor').filter({ hasText: 'Dr. Priya Raman' })).toContainText('Pediatrics');
  await expect(desk.getByRole('button', { name: 'Add doctor' })).toHaveCount(0); // the front desk looks, managers change

  const manager = await openAs(browser, 'manager');
  await manager.getByRole('link', { name: 'Doctors' }).click();
  await manager.getByRole('button', { name: 'Add doctor' }).click();
  const panel = manager.getByRole('dialog', { name: 'Add doctor' });
  await panel.getByLabel('Name').fill('Dr. Lena Ortiz');
  await panel.getByLabel('Gender').selectOption({ label: 'Female' });
  await panel.getByLabel('Specialty').fill('Dermatology');
  await panel.getByLabel('What they see people for').fill('Skin, Allergies');
  await panel.getByLabel('Their own hours, not the clinic\'s').check();
  await panel.getByRole('button', { name: 'Days off' }).click();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toBeHidden();
  await expect(manager.getByTestId('doctor').filter({ hasText: 'Dr. Lena Ortiz' })).toContainText('Dermatology, Female');

  // the front desk's open page updates on its own
  await expect(desk.getByTestId('doctor').filter({ hasText: 'Dr. Lena Ortiz' })).toBeVisible({ timeout: 10_000 });

  // and finds doctors by specialty
  await desk.getByLabel('Specialty').selectOption({ label: 'Dermatology' });
  await expect(desk.getByTestId('doctor')).toHaveCount(1);
  await expect(desk.getByTestId('doctor')).toContainText('Dr. Lena Ortiz');
});

test('patients show as you type: one letter, or a few digits of a phone number', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: 'Patients', exact: true }).click();
  // before anything is typed, the newest patients
  await expect(page.getByText('The newest patients first.', { exact: false })).toBeVisible();
  const search = page.getByLabel('Find a patient');
  const results = page.getByRole('list', { name: 'Matching patients' });
  await search.fill('m');
  await expect(results.getByRole('link', { name: /Maria Delgado/ })).toBeVisible();
  await search.fill('555-0147');
  await expect(results.getByRole('link', { name: /Maria Delgado/ })).toBeVisible();
  await expect(results.getByRole('link', { name: /Lucas Delgado/ })).toBeVisible(); // her son, on her phone
});

test('requests can be searched and narrowed to days', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await page.getByLabel('Search requests').fill('zzzz-nothing');
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByTestId('task').first()).toBeVisible();
});

test('the schedule lists cancelled visits on their own, as a history', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: 'Schedule', exact: true }).click();
  await page.getByLabel('Show').selectOption({ label: 'Cancelled only, as a list' });
  await expect(page.getByRole('heading', { name: 'Cancelled visits' })).toBeVisible();
  await page.getByLabel('Sort').selectOption({ label: 'Visit date, latest first' });
  await expect(page.getByTestId('cancelled')).toBeVisible();
});
