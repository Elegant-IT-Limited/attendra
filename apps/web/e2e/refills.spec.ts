import { expect, type Page, test } from '@playwright/test';
import { signInAgain } from './session';

// Refill findings (2026-11-16), with made-up data on the demo vet clinic: New request takes a refill with only its
// medicine and says what is missing otherwise (RF4); the request says "Medicine" as the form does (RF5); closing it
// lists the refill decisions first, chooses none, and each says whether it texts on this request (RF1, RF2). Each shown
// value is checked against what the server sends.
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { origin: new URL(page.url()).origin } });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('a refill: its medicine is enough, one word for it, and the decisions first with none chosen', async ({ browser }) => {
  const page = await signInAgain(browser, 'Vet clinic manager');
  const C = clinicOf(page);
  await page.goto(`/c/${C}/requests`);
  await page.getByRole('button', { name: /New request/ }).first().click();
  const panel = page.getByRole('dialog', { name: 'New request' });
  await panel.getByRole('button', { name: /refill/i }).first().click();
  const add = panel.getByRole('button', { name: 'Add request' });
  // RF4: nothing filled in yet: disabled, and it says what is missing
  await expect(add).toBeDisabled();
  await expect(panel.getByText('Add the medicine, or say what it is about.')).toBeVisible();
  await panel.getByLabel('Medicine').fill('Carprofen 75 mg');
  await expect(add).toBeEnabled();
  await add.click();
  await expect(panel).toBeHidden();

  type Served = { id: string; number: number; details: Record<string, string> };
  const mine = (await call<{ tasks: Served[] }>(page, 'POST', `/clinics/${C}/tasks/search`, { status: 'open', q: 'Carprofen 75 mg' })).tasks[0]!;
  expect(mine.details).toMatchObject({ medication: 'Carprofen 75 mg', reason: 'Refill: Carprofen 75 mg' });

  const row = page.getByTestId('task-row').filter({ has: page.getByTestId('request-number').getByText(`R-${mine.number}`, { exact: true }) });
  await row.click();
  const card = page.getByTestId('task');
  // RF5: the same word as the form, with the server's value
  await expect(card.getByText('Medicine', { exact: true })).toBeVisible();
  await expect(card.getByText('Medication', { exact: true })).toHaveCount(0);
  await expect(card.getByText(mine.details.medication!, { exact: true })).toBeVisible();

  // RF1 + RF2: the decisions first, none chosen, each saying whether it texts (written down at the desk: it does)
  if (await card.getByRole('button', { name: 'Claim' }).count()) await card.getByRole('button', { name: 'Claim' }).click();
  await card.getByRole('button', { name: 'Mark done' }).click();
  const outcome = card.getByLabel('Outcome');
  await expect(outcome).toHaveValue('');
  expect(await outcome.locator('option').allTextContents()).toEqual([
    'Choose what happened',
    'Sent to the pharmacy (no text: no pharmacy named)',
    'Approved, ready to pick up (texts the caller)',
    'Not approved (texts the caller to call us)',
    'Called back',
    'No answer, left a message',
    'Not needed',
  ]);
  await expect(card.getByRole('button', { name: 'Mark done' })).toBeDisabled();
  await outcome.selectOption({ label: 'Called back' });
  await expect(card.getByRole('button', { name: 'Mark done' })).toBeEnabled();
  await card.getByRole('button', { name: 'Back' }).click();
});
