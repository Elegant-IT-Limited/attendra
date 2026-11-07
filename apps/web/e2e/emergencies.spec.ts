import { expect, test } from '@playwright/test';
import { signInAgain } from './session';

// Batch 1b: Settings > Emergencies. A mode with what it needs, the preview of what callers will hear (open and closed,
// English and Spanish) from the same emergencyRoute the assistant follows, and the test-call page's line. The demo clinic
// hands emergencies to its on-call line (read from its older settings). Made-up hospitals and 555 numbers only.
test.describe.serial('emergency settings at a vet clinic', () => {
  test('shows how emergencies are handled now, previews what callers hear, and refuses to save a mode without what it needs', async ({ browser }) => {
    const page = await signInAgain(browser, 'Vet clinic manager');
    await page.goto(`${new URL(page.url()).pathname.replace(/\/$/, '')}/settings/emergencies`);
    await expect(page.getByRole('link', { name: 'Emergencies' })).toBeVisible();
    // the demo clinic's on-call line: "handle", any time
    await expect(page.getByText('Emergency calls here: transfer to the team now, any time.')).toBeVisible();
    await expect(page.getByRole('radio', { name: /We handle emergencies, any time/ })).toBeChecked();
    // the preview, from the engine's own lines: the one question, in both languages
    await expect(page.getByTestId('preview-en-open')).toContainText('Is this still an emergency right now?');
    await expect(page.getByTestId('preview-es-closed')).toContainText('¿Sigue siendo una emergencia ahora mismo?');
    await expect(page.getByTestId('preview-en-open')).toContainText("I'm putting you through to our team now.");
    // "hours" needs an after-hours hospital (the clinic's own hospital fills it in): without its name, Save waits
    await page.getByRole('radio', { name: /We handle emergencies in these hours/ }).click();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await page.getByLabel('Hospital name').fill('');
    await expect(page.getByText(/Still needed: .*after-hours hospital's name/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await page.getByLabel('Hospital name').fill('Night Owl Animal ER');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    // closed, the preview sends the caller to the after-hours hospital
    await expect(page.getByTestId('preview-en-closed')).toContainText('Night Owl Animal ER');
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('radio', { name: /We handle emergencies, any time/ })).toBeChecked();
  });

  test('the test-call page says where an emergency would go now', async ({ browser }) => {
    const page = await signInAgain(browser, 'Vet clinic manager');
    await page.goto(`${new URL(page.url()).pathname.replace(/\/$/, '')}/test-call`);
    await expect(page.getByTestId('emergency-line')).toContainText('Emergency calls here: transfer to the team now, any time.');
    await expect(page.getByTestId('emergency-line')).toContainText('A test call is never put through');
  });
});
