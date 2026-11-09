import { expect, test } from '@playwright/test';
import { testDate } from './clock';
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
  // the specialty alone under the name: sex beside it read as part of it ("Dermatology, Female")
  await expect(manager.getByTestId('doctor').filter({ hasText: 'Dr. Lena Ortiz' }).getByTestId('doctor-subtitle')).toHaveText('Dermatology');

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
  await expect(card).toContainText('Sick visit, Annual physical');

  // "All visit types" ticks every one, and the card says so
  await card.getByRole('button', { name: 'Edit hours and details' }).click();
  let panel = manager.getByRole('dialog', { name: 'Edit Dr. Ann Lindqvist' });
  const all = panel.getByRole('checkbox', { name: 'All visit types' });
  await expect(all).not.toBeChecked();
  await all.check();
  for (const name of ['Sick visit', 'Annual physical', 'New patient visit']) await expect(panel.getByRole('checkbox', { name, exact: true })).toBeChecked();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toBeHidden();
  await expect(card).toContainText('All visit types');

  // one click back to choosing; none ticked is refused in plain words, then back to what she did
  await card.getByRole('button', { name: 'Edit hours and details' }).click();
  panel = manager.getByRole('dialog', { name: 'Edit Dr. Ann Lindqvist' });
  await panel.getByRole('checkbox', { name: 'All visit types' }).uncheck();
  await expect(panel.getByRole('checkbox', { name: 'Sick visit', exact: true })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Save' }).click();
  const problem = manager.getByRole('dialog', { name: 'Not saved' });
  await expect(problem).toContainText('Choose at least one visit type they do.');
  await problem.getByRole('button', { name: 'OK' }).click();
  await panel.getByRole('checkbox', { name: 'Sick visit', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Annual physical', exact: true }).check();
  await expect(panel.getByRole('checkbox', { name: 'All visit types' })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toBeHidden();
  await expect(card).toContainText('Sick visit, Annual physical');

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
  await panel.getByRole('checkbox', { name: 'Ear check', exact: true }).check();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toBeHidden();
  await expect(manager.getByTestId('no-provider-warnings')).toHaveCount(0);
  expect(await saveVisitTypes(false)).toBe(200);
});

// Note 32: removing a doctor who still has visits opens the handover instead of a dead end. The server picks who takes
// each visit at the same time; the manager sees it, confirms, and then removes the doctor from the same dialog.
test('removing a doctor with visits to come moves them to another doctor first, then removes them', async ({ browser }) => {
  const manager = await openAs(browser, 'manager');
  const clinic = manager.url().split('/c/')[1]!;
  const origin = { origin: new URL(manager.url()).origin };
  const added = await manager.request.post(`/api/v1/clinics/${clinic}/doctors`, { headers: origin, data: {
    name: 'Dr. Rhea Vance', gender: 'female', acceptingNewPatients: true, categories: [], timeOff: [], visitTypeIds: ['vt_sick', 'vt_annual', 'vt_new'],
  } });
  expect(added.status(), await added.text()).toBe(201);
  const vance = ((await added.json()) as { providers: { id: string; name: string }[] }).providers.find((p) => p.name === 'Rhea Vance')!.id;
  // a time next week that is free for Dr. Vance and for someone else too
  const nextWeek = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(testDate(7 * 86_400_000));
  const slots = await (await manager.request.get(`/api/v1/clinics/${clinic}/appointments/slots?visitTypeId=vt_sick&providerId=${vance}&from=${nextWeek}&days=7`)).json() as { slots: { startsAt: string }[] };
  const found = await (await manager.request.post(`/api/v1/clinics/${clinic}/patients/search`, { headers: origin, data: { query: 'whit' } })).json() as { patients: { id: string; name: string }[] };
  let booked = false;
  for (const s of slots.slots.slice(0, 40)) {
    const res = await manager.request.post(`/api/v1/clinics/${clinic}/appointments`, { headers: origin, data: {
      patientId: found.patients.find((p) => p.name === 'James Whitaker')!.id, providerId: vance, visitTypeId: 'vt_sick', startsAt: s.startsAt, idempotencyKey: `e2e-handover-${s.startsAt}`,
    } });
    if (res.status() !== 201) continue;
    const preview = await (await manager.request.post(`/api/v1/clinics/${clinic}/doctors/${vance}/handover/preview`, { headers: origin, data: {} })).json() as { visits: { toProviderId: string | null; appointmentId: string }[] };
    if (preview.visits.every((v) => v.toProviderId)) { booked = true; break; }
    const { appointmentId } = await res.json() as { appointmentId: string };
    await manager.request.post(`/api/v1/clinics/${clinic}/appointments/${appointmentId}/cancel`, { headers: origin, data: {} });
  }
  expect(booked).toBe(true);

  await manager.goto(`/c/${clinic}/doctors`);
  await manager.getByTestId('doctor').filter({ hasText: 'Dr. Rhea Vance' }).getByRole('button', { name: 'Edit hours and details' }).click();
  const panel = manager.getByRole('dialog', { name: 'Edit Dr. Rhea Vance' });
  await panel.getByRole('button', { name: 'Remove', exact: true }).click();
  await panel.getByRole('button', { name: 'Remove', exact: true }).click();
  const handover = manager.getByRole('dialog', { name: 'Move Dr. Rhea Vance\'s visits' });
  await expect(handover.getByTestId('handover-summary')).toHaveText('1 of 1 can move.');
  await expect(handover.getByTestId('handover-visit')).toHaveCount(1);
  await expect(handover.getByLabel('Text the owners about the new doctor')).not.toBeChecked();
  await handover.getByTestId('handover-confirm').click();
  await expect(handover.getByTestId('handover-result')).toContainText('Moved 1 visit');
  await expect(handover.getByTestId('handover-result')).toContainText('No owner was texted.');
  await handover.getByTestId('handover-remove').click();
  await expect(manager.getByTestId('doctor').filter({ hasText: 'Dr. Rhea Vance' })).toHaveCount(0);
});

test('a vet card writes hours and time off on the clinic\'s 12-hour clock and phones the one way, from what the server stores', async ({ browser }) => {
  const manager = await openAs(browser, 'manager');
  const clinic = new URL(manager.url()).pathname.split('/')[2]!;
  const origin = { origin: new URL(manager.url()).origin };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(testDate(9 * 86_400_000));
  const added = await manager.request.post(`/api/v1/clinics/${clinic}/doctors`, { headers: origin, data: {
    name: 'Dr. Wren Halloway', gender: 'female', phone: '+13035550142', otherPhones: ['+13035550143'], acceptingNewPatients: true, categories: [],
    hours: { '1': [{ open: '08:00', close: '18:00' }] }, timeOff: [{ from: day, to: day, start: '13:00', end: '15:30' }],
  } });
  expect(added.status(), await added.text()).toBe(201);
  const stored = ((await added.json()) as { providers: { id: string; name: string; phone?: string; otherPhones?: string[]; hours?: Record<string, { open: string; close: string }[]> }[] }).providers.find((p) => p.name === 'Wren Halloway')!;
  try {
    await manager.goto(`/c/${clinic}/doctors`);
    const card = manager.getByTestId('doctor').filter({ hasText: 'Dr. Wren Halloway' });
    // the server's E.164, shown as US numbers are written everywhere else: "(303) 555-0142"
    const shown = (e164: string) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
    await expect(card.getByTestId('doctor-phone')).toHaveText([stored.phone!, ...stored.otherPhones!].map(shown).join(', '));
    // the server's 08:00-18:00, on the same clock as Settings and the schedule
    expect(stored.hours!['1']).toEqual([{ open: '08:00', close: '18:00' }]);
    await expect(card).toContainText('Mon 8:00 AM-6:00 PM');
    await expect(card).toContainText('1:00 PM to 3:30 PM');
    await expect(card).not.toContainText(/\b\d{2}:\d{2}\b/);
    await expect(card).not.toContainText('+1303');
    // no specialty: the subtitle says so, and nothing else
    await expect(card.getByTestId('doctor-subtitle')).toHaveText('No specialty set');
  } finally {
    await manager.request.delete(`/api/v1/clinics/${clinic}/doctors/${stored.id}`, { headers: origin });
  }
});
