import { expect, test } from '@playwright/test';
import { openAs, signInAgain } from './session';

// Batch 4b: how an animal's emergency ended, on the Calls list and the call page, and the filter for it that the API
// answers (CALL-2); the longest wait and the questions asked again on the call page (CALL-3). The vet demo clinic's
// recorded calls; made-up callers only.
const LABELS: Record<string, string> = {
  transferred: 'Emergency · put through', hospital_said: 'Emergency · sent to hospital', hospital_texted: 'Emergency · hospital texted',
  urgent_request: 'Emergency · urgent request', cleared: 'Emergency cleared',
};

test('the Calls list filters by how an emergency ended, on the server, and the call page says it in plain words', async ({ browser }) => {
  const page = await signInAgain(browser, 'Vet clinic manager');
  const base = new URL(page.url()).pathname.replace(/\/$/, '');
  const clinicId = base.split('/').at(-1)!;
  // which results the demo's recorded emergencies ended with: the filter is checked against one of them
  const listed = await (await page.request.get(`/api/v1/clinics/${clinicId}/calls?emergency=true&limit=100`)).json() as { calls: { id: string; emergencyResult: string | null }[] };
  const result = listed.calls.find((c) => c.emergencyResult)?.emergencyResult;
  expect(result, 'the demo has an animal emergency with a result').toBeTruthy();
  const label = LABELS[result!]!;

  await page.getByRole('link', { name: 'Calls', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  const asked = page.waitForRequest((r) => r.url().includes('/calls?') && r.url().includes(`emergencyResult=${result}`));
  await page.getByLabel('Emergency result').selectOption({ label });
  await asked;
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText(label);
  const count = await rows.count();
  for (let i = 0; i < count; i++) await expect(rows.nth(i)).toContainText(label);

  await rows.first().getByRole('link').click();
  await expect(page).toHaveURL(/\/calls\/[^/]+$/);
  await expect(page.getByRole('alert').filter({ hasText: label }).or(page.getByText(label).first())).toBeVisible();
  // how it went for the caller, from the call's own turns
  await expect(page.getByRole('heading', { name: 'How it went for the caller' })).toBeVisible();
  await expect(page.getByTestId('longest-wait')).toContainText(/\d\.\d s|No reply to time/);
  await expect(page.getByTestId('repeated-questions')).toContainText(/Questions asked again\s*\d/);
  // a plain close reason, never a code
  await expect(page.getByTestId('close-reason')).not.toContainText('_');

  // the filter clears with the others
  await page.goBack();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByLabel('Emergency result')).toHaveValue('');
});

test('every outcome and every emergency result is an option in the Calls filters', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  await page.getByRole('link', { name: 'Calls', exact: true }).click();
  await expect(page.getByLabel('Outcome').locator('option', { hasText: 'Caller heard nothing' })).toHaveCount(1);
  for (const label of Object.values(LABELS)) await expect(page.getByLabel('Emergency result').locator('option', { hasText: label })).toHaveCount(1);
  await expect(page.getByLabel('Channel').locator('option')).toHaveText(['Any channel', 'Phone', 'Browser test']);
});
