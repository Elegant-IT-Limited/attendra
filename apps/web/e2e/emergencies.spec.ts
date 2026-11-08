import { expect, test } from '@playwright/test';
import { signInAgain } from './session';

// Batch 1b: Settings > Emergencies. A mode with what it needs, the preview of what callers will hear (open and closed,
// English and Spanish) from the same emergencyRoute the assistant follows, and the test-call page's line. The demo clinic
// hands emergencies to its on-call line (its emergency setting). Batch 1e: the one place a vet clinic's route is edited,
// its hospitals in order, and the choice saved shown again after a reload. Made-up hospitals and 555 numbers only.
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

  test('saves a choice with its hospitals in order, shows it again after a reload, and General no longer edits emergency hospitals (batch 1e)', async ({ browser }) => {
    const page = await signInAgain(browser, 'Vet clinic manager');
    const base = new URL(page.url()).pathname.replace(/\/$/, '');
    await page.goto(`${base}/settings/emergencies`);
    await page.getByRole('radio', { name: /Refer emergencies to a hospital/ }).click();
    // the clinic's own hospital fills the form in; the next choice, part of the day only
    await page.getByLabel('Hospital name').first().fill('Northside Animal ER');
    await page.getByRole('button', { name: 'Hospital', exact: true }).click();
    await page.locator('#more-0-name').fill('Night Paws Emergency');
    await page.locator('#more-0-phone').fill('(720) 555-0189');
    await page.locator('#more-0-address').fill('9 Night Road, Denver');
    await page.locator('#more-0-24h').click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. The next call follows this setting.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('radio', { name: /Refer emergencies to a hospital/ })).toBeChecked();
    await expect(page.locator('#hospital-name')).toHaveValue('Northside Animal ER');
    await expect(page.locator('#more-0-name')).toHaveValue('Night Paws Emergency');
    await expect(page.getByText('Emergency calls here: sent to Northside Animal ER, any time.')).toBeVisible();
    await expect(page.getByTestId('preview-es-open')).toContainText('Por favor lleve a Luna ahora mismo a Northside Animal ER');
    // Settings > General has no emergency hospitals of its own any more
    await page.goto(`${base}/settings`);
    await expect(page.getByRole('heading', { name: 'Opening hours' }).first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Emergency hospitals' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Emergency hospitals' })).toHaveCount(0);

    // back to the demo clinic's on-call line, for the specs after this one
    await page.goto(`${base}/settings/emergencies`);
    await page.getByRole('button', { name: 'Remove Night Paws Emergency' }).click();
    await page.getByRole('radio', { name: /We handle emergencies, any time/ }).click();
    await page.locator('#emergency-number').fill('(720) 555-0179');
    await page.locator('#emergency-number').blur();
    await page.locator('#backup-on').click();
    await page.locator('#backup-name').fill('Front Range Pet Emergency');
    await page.locator('#backup-phone').fill('(720) 555-0188');
    await page.locator('#backup-address').fill('1200 Larkspur Avenue, Denver');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. The next call follows this setting.')).toBeVisible();
    await expect(page.getByText('Emergency calls here: transfer to the team now, any time.')).toBeVisible();
  });
});
