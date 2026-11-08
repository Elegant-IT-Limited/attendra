import { expect, test } from '@playwright/test';
import { openAs } from './session';

test.describe.serial('patients', () => {
  test('search finds Maria Delgado by name and by date of birth', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.getByRole('link', { name: 'Patients' }).click();
    const search = page.getByLabel('Find a patient');
    const results = page.getByRole('list', { name: 'Matching patients' });
    await search.fill('delg');
    await expect(results.getByRole('link', { name: /^Maria Delgado/ })).toBeVisible();
    await search.fill('03/04/1985');
    await expect(results.getByRole('link')).toHaveCount(1);
    await expect(results.getByRole('link', { name: /^Maria Delgado/ })).toBeVisible();
    await search.fill('March 4 1985');
    await expect(results.getByRole('link', { name: /^Maria Delgado/ })).toBeVisible();
    await expect(page).not.toHaveURL(/1985|delg/i); // what was typed never reaches the address bar
    await results.getByRole('link', { name: /^Maria Delgado/ }).click();
    await expect(page.getByRole('heading', { name: 'Maria Delgado' })).toBeVisible();
  });

  test('a phone field takes numbers only: letters typed or pasted are dropped, with a note', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.getByRole('link', { name: 'Patients' }).click();
    await page.getByRole('button', { name: 'Add patient' }).click();
    const phone = page.getByRole('dialog', { name: 'Add patient' }).getByLabel(/Phone/);
    await expect(phone).toHaveAttribute('type', 'tel');
    await expect(phone).toHaveAttribute('inputmode', 'tel');
    await phone.pressSequentially('720 CALL 555 0188');
    await expect(phone).toHaveValue('720  555 0188');
    await expect(page.getByText('Use numbers only, for example (555) 555-0123.')).toBeVisible();
    await phone.fill('');
    await phone.pressSequentially('(720) 555-0188');
    await expect(phone).toHaveValue('(720) 555-0188');
  });

  test('front desk adds a patient, then books them', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.getByRole('link', { name: 'Patients' }).click();
    await page.getByRole('button', { name: 'Add patient' }).click();
    const form = page.getByRole('dialog', { name: 'Add patient' });
    await form.getByLabel('First name').fill('Tessa');
    await form.getByLabel('Last name').fill('Okoro');
    await form.getByLabel('Date of birth').fill('1993-02-11');
    await form.getByLabel('Gender').selectOption({ label: 'Female' });
    await form.getByLabel(/Phone/).fill('(720) 555-0188');
    await form.getByRole('button', { name: 'Add patient' }).click();

    await expect(page.getByRole('heading', { name: 'Tessa Okoro' })).toBeVisible();
    await expect(page.getByText('No appointments yet')).toBeVisible();
    await page.getByRole('button', { name: 'Book' }).click();
    const dialog = page.getByRole('dialog', { name: 'New booking' });
    await expect(dialog.getByText('For Tessa Okoro')).toBeVisible();
    await dialog.getByLabel('Visit type').selectOption({ label: 'New patient visit (60 min)' });
    // a doctor added by an earlier spec can see new patients too, so the doctor is chosen
    await dialog.getByLabel('Provider').selectOption({ label: 'Dr. Nkem Okafor' });
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

  test('a busy API (429) is tried again, and the search result still appears', async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    let searches = 0;
    // the first search is turned away once, as the API does when it is busy; the retry goes through
    await page.route((u) => u.pathname.endsWith('/patients/search'), (route) => (searches++ === 0
      ? route.fulfill({ status: 429, headers: { 'retry-after': '1' }, json: { error: 'rate_limited' } })
      : route.fallback()));
    await page.getByRole('link', { name: 'Patients' }).click();
    await page.getByLabel('Find a patient').fill('delg');
    await expect(page.getByRole('list', { name: 'Matching patients' }).getByRole('link', { name: /^Maria Delgado/ })).toBeVisible();
    expect(searches).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('Attendra is busy for a moment')).toHaveCount(0);
  });
});

// DATA-5: a practice manager merges a duplicate record and deletes one, each after a confirm step with the server's
// counts; the front desk sees neither button.
test('a manager merges a duplicate into a record and deletes another, after seeing what moves or goes', async ({ browser }) => {
  const desk = await openAs(browser, 'frontdesk');
  const clinic = new URL(desk.url()).pathname.split('/')[2];
  const origin = { origin: new URL(desk.url()).origin };
  const add = async (firstName: string, lastName: string, phone: string, dob: string) => {
    const res = await desk.request.post(`/api/v1/clinics/${clinic}/patients`, { headers: origin, data: { firstName, lastName, dob, phone, gender: 'female' } });
    expect(res.status(), await res.text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const keep = await add('Odile', 'Fenwick', '+13035550156', '1971-02-03');
  const dupe = await add('Odile', 'Fenwik', '+13035550156', '1971-02-03');
  const gone = await add('Pell', 'Mardon', '+13035550157', '1966-07-08');
  await desk.goto(`/c/${clinic}/patients/${keep}`);
  await expect(desk.getByRole('heading', { name: 'Odile Fenwick' })).toBeVisible();
  await expect(desk.getByTestId('merge-open')).toHaveCount(0);
  await expect(desk.getByTestId('delete-open')).toHaveCount(0);

  const manager = await openAs(browser, 'manager');
  await manager.goto(`/c/${clinic}/patients/${keep}`);
  await manager.getByTestId('merge-open').click();
  const merge = manager.getByRole('dialog', { name: 'Merge into Odile Fenwick' });
  await merge.getByLabel('Find a patient').fill('fenwik');
  await merge.getByRole('button', { name: /Odile Fenwik/ }).click();
  await expect(merge.getByTestId('merge-preview')).toContainText('1 record merged away');
  await merge.getByTestId('merge-confirm').click();
  await expect(merge).toBeHidden();
  expect((await manager.request.get(`/api/v1/clinics/${clinic}/patients/${dupe}`)).status()).toBe(404);

  await manager.goto(`/c/${clinic}/patients/${gone}`);
  await manager.getByTestId('delete-open').click();
  const remove = manager.getByRole('dialog', { name: 'Delete Pell Mardon' });
  await expect(remove.getByTestId('delete-preview')).toContainText('1 record emptied');
  await expect(remove.getByTestId('delete-preview')).toContainText('0 visits still to come cancelled');
  await remove.getByTestId('delete-confirm').click();
  await expect(manager).toHaveURL(new RegExp(`/c/${clinic}/patients$`), { timeout: 20_000 });
  expect((await manager.request.get(`/api/v1/clinics/${clinic}/patients/${gone}`)).status()).toBe(404);
  const found = await (await manager.request.post(`/api/v1/clinics/${clinic}/patients/search`, { headers: origin, data: { query: 'mardon' } })).json() as { patients: unknown[] };
  expect(found.patients).toEqual([]);
});
