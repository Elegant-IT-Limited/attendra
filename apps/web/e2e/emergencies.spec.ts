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
  // Note 52 C10: a clinic with no emergency setting saw "Refer emergencies to a hospital" selected, and a banner sending
  // it to the page it was on. Nothing is chosen until the manager chooses; the banner says to choose below.
  test('with no setting saved, no choice shows as made and the line says to choose one below', async ({ browser }) => {
    const page = await signInAgain(browser, 'Vet clinic manager');
    // this clinic's settings as the server sends them, without an emergency setting: the page's own handling is under test
    await page.route((url) => url.pathname.startsWith('/api/v1/') && url.pathname.endsWith('/settings'), async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = await res.json() as Record<string, unknown>;
      delete body.emergencies;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`${new URL(page.url()).pathname.replace(/\/$/, '')}/settings/emergencies`);
    await expect(page.getByText('Emergency calls here: no emergency setting yet, so callers hear "the nearest 24-hour emergency vet". Choose one below.')).toBeVisible();
    await expect(page.getByText('Set one under Settings > Emergencies')).toHaveCount(0);
    const radios = page.getByRole('radiogroup', { name: 'How this location handles emergencies' }).getByRole('radio');
    await expect(radios).toHaveCount(3);
    for (const radio of await radios.all()) await expect(radio).not.toBeChecked();
    // no form for a choice nobody made, and nothing to save yet
    await expect(page.getByLabel('Hospital name')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    // choosing one shows it chosen, with what it needs and the bar to save it; Discard goes back to none chosen
    await page.getByRole('radio', { name: /Refer emergencies to a hospital/ }).click();
    await expect(page.getByRole('radio', { name: /Refer emergencies to a hospital/ })).toBeChecked();
    await expect(page.getByLabel('Hospital name').first()).toBeVisible();
    await expect(page.getByText(/Still needed: /)).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();
    for (const radio of await radios.all()) await expect(radio).not.toBeChecked();
  });
});
