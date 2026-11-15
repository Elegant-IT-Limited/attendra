import { expect, type Page, test } from '@playwright/test';
import { signInAgain } from './session';

// Dashboard findings from a test clinic (2026-11-16), with made-up data on the demo vet clinic: a renamed dropdown
// choice reaches every record (F1); a request of the clinic's own kind is labelled by its name everywhere (R2); New
// request takes the pet's number (R1); a visit type no vet does says so on its own card (V2). Each shown value is
// checked against what the server sends.
type Settings = Record<string, unknown> & { timezone: string; customFields?: unknown[]; requestFields?: unknown[]; requestTopics?: unknown[] };
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { origin: new URL(page.url()).origin } });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}
const digits = (s: string) => s.replace(/\D/g, '');

test.describe('dashboard findings, 2026-11-16', () => {
  let page: Page;
  let C: string;
  let original: Settings;
  test.beforeAll(async ({ browser }) => {
    page = await signInAgain(browser, 'Vet clinic manager');
    C = clinicOf(page);
    original = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
  });
  // the demo clinic's own fields and kinds of request as they were, for the specs after this one
  test.afterAll(async () => {
    const now = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    await call(page, 'PUT', `/clinics/${C}/settings`, { ...now, customFields: original.customFields ?? [], requestFields: original.requestFields ?? [], requestTopics: original.requestTopics ?? [] });
  });

  test('F1: a renamed dropdown choice reaches the pet and the request that have it, on the list and in Details', async () => {
    const now = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    await call(page, 'PUT', `/clinics/${C}/settings`, {
      ...now,
      customFields: [{ id: 'insurer', label: 'Pet insurance', kind: 'choice', options: ['Acme Pet Cover', 'Northwind Pet Plan'], column: true }],
      requestFields: [{ id: 'wing', label: 'Boarding wing', kind: 'choice', options: ['North wing', 'South wing'] }],
    });
    const pet = (await call<{ patients: { id: string; name: string }[] }>(page, 'GET', `/clinics/${C}/patients`)).patients[0]!;
    await call(page, 'PUT', `/clinics/${C}/patients/${pet.id}/fields`, { values: { insurer: 'Acme Pet Cover' } });
    const task = await call<{ id: string; number: number }>(page, 'POST', `/clinics/${C}/tasks`, { type: 'callback', reason: 'Asked which wing their dog boards in', patientId: pet.id });
    await call(page, 'PUT', `/clinics/${C}/tasks/${task.id}/fields`, { values: { wing: 'South wing' } });

    await page.goto(`/c/${C}/settings/fields?tab=patients`);
    await page.getByLabel('Pet insurance: choice 1').fill('Acme Pet Cover Plus');
    await page.getByRole('button', { name: 'Save fields' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Requests' }).click();
    await page.getByLabel('Boarding wing: choice 2').fill('South wing (kennels)');
    await page.getByRole('button', { name: 'Save fields' }).click();
    await expect(page.getByText('Saved.', { exact: true }).first()).toBeVisible();

    // the server renamed both records
    const served = await call<{ customFields: Record<string, string> }>(page, 'GET', `/clinics/${C}/patients/${pet.id}`);
    expect(served.customFields.insurer).toBe('Acme Pet Cover Plus');
    const tasks = (await call<{ tasks: { id: string; custom: Record<string, string> }[] }>(page, 'POST', `/clinics/${C}/tasks/search`, { status: 'open', q: '' })).tasks;
    expect(tasks.find((t) => t.id === task.id)?.custom.wing).toBe('South wing (kennels)');

    // and every screen shows what it sent: the pet's Details (not "Not filled in"), the Pets list, the request
    await page.goto(`/c/${C}/patients/${pet.id}`);
    await page.getByRole('tab', { name: 'Details' }).click();
    await expect(page.getByLabel('Pet insurance')).toHaveValue(served.customFields.insurer!);
    await expect(page.getByLabel('Pet insurance').locator('option:checked')).toHaveText(served.customFields.insurer!);
    await page.goto(`/c/${C}/patients`);
    await expect(page.getByRole('link', { name: new RegExp(`Pet insurance: ${served.customFields.insurer!}`) }).locator('visible=true').first()).toBeVisible();
    await page.goto(`/c/${C}/requests?open=${task.id}`);
    await expect(page.getByTestId('task').getByText('South wing (kennels)', { exact: true })).toBeVisible();
  });

  test('R2 and R1: a request of the clinic\'s own kind is labelled by its name everywhere, and New request takes the pet\'s number', async () => {
    const now = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    await call(page, 'PUT', `/clinics/${C}/settings`, { ...now, requestTopics: [{ id: 'topic_board', name: 'Boarding booking', collect: 'The dates' }] });
    const pet = (await call<{ patients: { id: string; name: string; phone: string | null }[] }>(page, 'GET', `/clinics/${C}/patients`)).patients.find((p) => p.phone)!;

    await page.goto(`/c/${C}/requests`);
    await page.getByRole('button', { name: /New request/ }).first().click();
    const panel = page.getByRole('dialog', { name: 'New request' });
    await panel.getByRole('button', { name: /Boarding booking/ }).click();
    await panel.getByRole('button', { name: /Find the pet/ }).click();
    await panel.getByRole('textbox').first().fill(pet.name.split(' ')[0]!);
    await panel.locator('ul button').filter({ hasText: pet.name.split(' ')[0]! }).first().click();
    await expect(panel.getByTestId('picked-record')).toBeVisible();
    // R1: the number on file, editable
    const callBack = panel.getByLabel('Call back on');
    await expect(callBack).not.toHaveValue('');
    expect(digits(await callBack.inputValue())).toBe(digits(pet.phone!).slice(-10));
    await expect(callBack).toBeEditable();
    await panel.getByLabel('What it is about').fill('Wants to board the dog for three nights from Friday');
    await panel.getByRole('button', { name: 'Add request' }).click();
    await expect(panel).toBeHidden();

    type Served = { id: string; number: number; details: Record<string, string> };
    const mine = (await call<{ tasks: Served[] }>(page, 'POST', `/clinics/${C}/tasks/search`, { status: 'open', q: 'three nights from Friday' })).tasks[0]!;
    expect(mine.details.topic).toBe('Boarding booking');
    expect(digits(mine.details.callback_number!)).toBe(digits(pet.phone!));
    const label = `R-${mine.number} · ${mine.details.topic}`;

    // the list row: the kind is the label, what it is about is the summary
    const row = page.getByTestId('task-row').filter({ has: page.getByTestId('request-number').getByText(`R-${mine.number}`, { exact: true }) });
    await expect(row.getByTestId('request-kind')).toHaveText(mine.details.topic!);
    await expect(row).toContainText(mine.details.reason!);
    // Callback lists built-in callbacks only
    await page.locator('#request-type').selectOption('callback');
    await expect(row).toHaveCount(0);
    await page.locator('#request-type').selectOption('topic:Boarding booking');
    await expect(row).toHaveCount(1);
    // the panel: its title and the kind under the name; its history; "Done" offered first when it is done
    await row.click();
    await expect(page.getByRole('dialog', { name: label })).toBeVisible();
    const card = page.getByTestId('task');
    await expect(card.getByText(new RegExp(`^${mine.details.topic}, came in`))).toBeVisible();
    await card.getByTestId('request-history').getByText('History').click();
    await expect(card.getByTestId('request-history').getByText(`Took a request: ${mine.details.topic}`)).toBeVisible();
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(card.getByLabel('Outcome').locator('option').first()).toHaveText('Done');
    await expect(card.getByLabel('Outcome')).toHaveValue('');
    await card.getByRole('button', { name: 'Back' }).click();
    await page.keyboard.press('Escape');

    // the pet's Requests tab: the kind as the label, the details without it
    await page.goto(`/c/${C}/patients/${pet.id}`);
    await page.getByRole('tab', { name: /Requests/ }).click();
    const item = page.getByRole('listitem').filter({ hasText: `R-${mine.number} ·` });
    await expect(item.getByText(label, { exact: true })).toBeVisible();
    await expect(item).not.toContainText(`, ${mine.details.topic}`);
    // a number in a request's details reads as the header writes it, never +1…
    await expect(page.getByRole('list').filter({ has: item })).not.toContainText(/\+\d{11}/);
    // the audit log
    await page.goto(`/c/${C}/audit`);
    await expect(page.getByRole('row', { name: new RegExp(`Took a request of one of the clinic's own kinds Request R-${mine.number}$`) }).first()).toBeVisible();
  });

  test('V2: a visit type no vet does says so on its own card, as it is typed', async () => {
    await page.goto(`/c/${C}/settings`);
    const visits = page.locator('#visits');
    await visits.getByRole('button', { name: 'Visit type' }).click();
    const name = visits.getByPlaceholder('e.g. Dental cleaning').first();
    await name.fill('dental check-up');
    // on the new card, right under what was typed; a visit type the vets do has none
    const warning = visits.getByRole('status').filter({ hasText: 'No vet does' });
    await expect(warning).toHaveText('No vet does dental check-up: callers can\'t book it. Choose who does it on the Veterinarians page.');
    await expect(visits.locator(`#item-${await warning.evaluate((el) => el.closest('[id^="item-"]')?.id.slice(5))}`).getByPlaceholder('e.g. Dental cleaning')).toHaveValue('dental check-up');
    await page.getByRole('button', { name: 'Discard' }).click();
  });
});
