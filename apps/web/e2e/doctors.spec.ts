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
  await expect(results.getByRole('link', { name: /^Maria Delgado/ })).toBeVisible();
  await search.fill('555-0147');
  await expect(results.getByRole('link', { name: /^Maria Delgado/ })).toBeVisible(); // her children name her as their guardian, so the start of the name
  await expect(results.getByRole('link', { name: /Lucas Delgado/ })).toBeVisible(); // her son, on her phone
});

test('requests can be searched and narrowed to days', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await page.getByLabel('Search requests').fill('zzzz-nothing');
  await expect(page.getByText(/^Nothing matches\. Search by/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByTestId('task-row').first()).toBeVisible();
});

test('the schedule lists cancelled visits on their own, as a history', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: 'Schedule', exact: true }).click();
  await page.getByLabel('Show').selectOption({ label: 'Cancelled (history)' });
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

test('a doctor\'s visit types: ticked one by one or all in one click, and a warning for a type nobody does', async ({ browser }) => {
  const manager = await openAs(browser, 'manager');
  const clinic = manager.url().split('/c/')[1]!;
  await manager.getByRole('link', { name: 'Doctors' }).click();
  const card = manager.getByTestId('doctor').filter({ hasText: 'Dr. Ann Lindqvist' });
  await expect(card).toContainText('Visit types they do');
  await expect(card).toContainText('sick visit, annual physical');

  // "All visit types" ticks every one, and the card says so
  await card.getByRole('button', { name: 'Edit hours and details' }).click();
  let panel = manager.getByRole('dialog', { name: 'Edit Dr. Ann Lindqvist' });
  const all = panel.getByRole('checkbox', { name: 'All visit types' });
  await expect(all).not.toBeChecked();
  await all.check();
  for (const name of ['sick visit', 'annual physical', 'new patient visit']) await expect(panel.getByRole('checkbox', { name, exact: true })).toBeChecked();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toBeHidden();
  await expect(card).toContainText('All visit types');

  // one click back to choosing; none ticked is refused in plain words, then back to what she did
  await card.getByRole('button', { name: 'Edit hours and details' }).click();
  panel = manager.getByRole('dialog', { name: 'Edit Dr. Ann Lindqvist' });
  await panel.getByRole('checkbox', { name: 'All visit types' }).uncheck();
  await expect(panel.getByRole('checkbox', { name: 'sick visit', exact: true })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Save' }).click();
  const problem = manager.getByRole('dialog', { name: 'Not saved' });
  await expect(problem).toContainText('Choose at least one visit type they do.');
  await problem.getByRole('button', { name: 'OK' }).click();
  await panel.getByRole('checkbox', { name: 'sick visit', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'annual physical', exact: true }).check();
  await expect(panel.getByRole('checkbox', { name: 'All visit types' })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toBeHidden();
  await expect(card).toContainText('sick visit, annual physical');

  // a visit type nobody does: Settings and the Doctors page say it in the same words
  const warning = 'No doctor does ear check: callers can\'t book it';
  const saveVisitTypes = (add: boolean) => manager.evaluate(async ({ id, add }) => {
    const settings = await (await fetch(`/api/v1/clinics/${id}/settings`)).json();
    const visitTypes = add ? [...settings.visitTypes, { id: 'vt_ear_e2e', name: 'ear check', minutes: 20, audience: 'all' }] : settings.visitTypes.filter((v: { id: string }) => v.id !== 'vt_ear_e2e');
    return (await fetch(`/api/v1/clinics/${id}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, visitTypes }) })).status;
  }, { id: clinic, add });
  expect(await saveVisitTypes(true)).toBe(200);
  await manager.goto(`/c/${clinic}/settings`);
  await expect(manager.locator('#visits').getByText(warning)).toBeVisible();
  await manager.goto(`/c/${clinic}/doctors`);
  await expect(manager.getByTestId('no-provider-warnings')).toHaveText(warning);
  // ticked for one doctor, the warning goes
  await card.getByRole('button', { name: 'Edit hours and details' }).click();
  panel = manager.getByRole('dialog', { name: 'Edit Dr. Ann Lindqvist' });
  await panel.getByRole('checkbox', { name: 'ear check', exact: true }).check();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toBeHidden();
  await expect(manager.getByTestId('no-provider-warnings')).toHaveCount(0);
  expect(await saveVisitTypes(false)).toBe(200);
});
