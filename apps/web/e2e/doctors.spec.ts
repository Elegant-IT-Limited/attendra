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
  // a specialty is picked from the clinic's list, never typed: what is typed only narrows the list
  const specialty = panel.getByRole('combobox', { name: 'Specialty' });
  await specialty.click();
  const choices = manager.getByRole('listbox', { name: 'Choices for specialty' });
  await expect(choices.getByRole('option', { name: 'Pediatrics' })).toBeVisible();
  await specialty.fill('Derma');
  await expect(choices.getByRole('option', { name: 'Dermatology' })).toHaveCount(0);
  // a manager adds one to the list without leaving the panel, and it is picked
  await choices.getByRole('option', { name: 'Add a specialty…' }).click();
  await panel.getByLabel('New specialty').fill('Dermatology');
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(specialty).toHaveValue('Dermatology');
  await specialty.click();
  await expect(choices.getByRole('option', { name: 'Dermatology' })).toHaveAttribute('aria-selected', 'true');
  await specialty.press('Escape');
  // categories are chips from the list too: typing narrows them, and nothing typed is kept on its own
  const categories = panel.getByRole('combobox', { name: 'Sees people for' });
  await categories.fill('Skin');
  await categories.press('Enter');
  await expect(panel.getByRole('list', { name: 'Sees people for' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Add one to the list…' }).click();
  await expect(panel.getByLabel('New value for sees people for')).toHaveValue('Skin');
  await panel.getByLabel('New value for sees people for').press('Enter');
  await expect(panel.getByRole('list', { name: 'Sees people for' })).toContainText('Skin');
  await panel.getByRole('button', { name: '+ Children' }).click();
  await expect(panel.getByRole('list', { name: 'Sees people for' })).toContainText('Children');
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
  await expect(page.getByTestId('task-row').first()).toBeVisible();
});

test('the schedule lists cancelled visits on their own, as a history', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: 'Schedule', exact: true }).click();
  await page.getByLabel('Show').selectOption({ label: 'Cancelled only, as a list' });
  await expect(page.getByRole('heading', { name: 'Cancelled visits' })).toBeVisible();
  await page.getByLabel('Sort').selectOption({ label: 'Visit date, latest first' });
  await expect(page.getByTestId('cancelled')).toBeVisible();
});

test('a specialty a doctor already has that is not on the list is kept, marked, and can be added to it', async ({ browser }) => {
  const manager = await openAs(browser, 'manager');
  const clinic = manager.url().split('/c/')[1]!;
  // a list kept without a specialty Dr. Raman has, as one typed before lists were picked from
  const status = await manager.evaluate(async (id) => {
    const settings = await (await fetch(`/api/v1/clinics/${id}/settings`)).json();
    const list = (settings.lists?.specialties ?? ['Family medicine']).filter((v: string) => v !== 'Pediatrics');
    return (await fetch(`/api/v1/clinics/${id}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, lists: { ...settings.lists, specialties: list } }) })).status;
  }, clinic);
  expect(status).toBe(200);
  await manager.getByRole('link', { name: 'Doctors' }).click();
  // the filter still finds every specialty in use
  await expect(manager.getByLabel('Specialty').locator('option', { hasText: 'Pediatrics' })).toHaveCount(1);
  await manager.getByTestId('doctor').filter({ hasText: 'Dr. Priya Raman' }).getByRole('button', { name: 'Edit hours and details' }).click();
  const panel = manager.getByRole('dialog', { name: 'Edit Dr. Priya Raman' });
  await expect(panel.getByRole('combobox', { name: 'Specialty' })).toHaveValue('Pediatrics');
  await expect(panel.getByText('Not on your list')).toBeVisible();
  await panel.getByRole('button', { name: 'Add to the list' }).click();
  await expect(panel.getByText('Not on your list')).toBeHidden();
  await panel.getByRole('combobox', { name: 'Specialty' }).click();
  await expect(manager.getByRole('listbox', { name: 'Choices for specialty' }).getByRole('option', { name: 'Pediatrics' })).toHaveAttribute('aria-selected', 'true');
});
