import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

test.describe.serial('languages and a second clinic', () => {
  // one manager page for the whole spec
  let manager: Page;
  test.beforeAll(async ({ browser }) => { manager = await openAs(browser, 'manager'); });

  test('the Cedar Park front desk sees only its own clinic, even by address', async ({ browser }) => {
    const page = await openAs(browser, 'cedarpark');
    await expect(page.getByText('Cedar Park Clinic').first()).toBeVisible();
    await expect(page.getByText('Maple Street Family Medicine')).toHaveCount(0);
    const other = await page.request.get('/api/v1/clinics/clinic_demo_maple/settings');
    expect([403, 404]).toContain(other.status());
    await page.goto('/c/clinic_demo_maple');
    await expect(page.getByText('Maria Delgado')).toHaveCount(0);
  });

  test('Maple Street\'s manager cannot open Cedar Park', async () => {
    const res = await manager.request.get('/api/v1/clinics/clinic_demo_cedar_park/settings');
    expect([403, 404]).toContain(res.status());
  });

  test('the assistant\'s name and languages, with a greeting preview in each', async () => {
    const page = manager;
    await page.getByRole('link', { name: 'Settings' }).click();
    const name = page.getByLabel('Assistant name');
    await expect(name).toHaveValue('Maya');
    await expect(page.getByTestId('greeting-preview-es')).toContainText('Soy Maya, la asistente virtual');

    await name.fill('Lena');
    await expect(page.getByTestId('greeting-preview-es')).toContainText('Soy Lena, la asistente virtual');
    await page.getByRole('button', { name: 'Use the suggested greeting' }).click();
    await expect(page.getByLabel('Greeting')).toHaveValue("Thanks for calling Maple Street Family Medicine. I'm Lena, the clinic's AI assistant. How can I help you today?");
    await expect(page.getByTestId('greeting-preview-en')).toContainText("I'm Lena");

    // a name is not a disclosure
    await page.getByLabel('Greeting').fill("Thanks for calling Maple Street. I'm Lena. How can I help?");
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('the greeting must disclose that the caller is speaking with an AI assistant')).toBeVisible();

    await page.getByRole('button', { name: 'Use the suggested greeting' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. The next call uses these settings.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Assistant name')).toHaveValue('Lena');

    // put the demo back as it was for the specs after this one
    await page.getByLabel('Assistant name').fill('Maya');
    await page.getByRole('button', { name: 'Use the suggested greeting' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. The next call uses these settings.')).toBeVisible();
  });

  // last, since it ends the stored Cedar Park session, which no spec after this one uses
  test('signing out clears the screen', async ({ browser }) => {
    const page = await openAs(browser, 'cedarpark');
    await page.getByRole('button', { name: /account and theme/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
