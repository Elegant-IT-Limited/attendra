import { expect, type Page, test } from '@playwright/test';
import { openAs, signInAgain } from './session';

test.describe.serial('languages and a second clinic', () => {
  // one manager sign-in for the whole spec: sign-in is rate limited
  let manager: Page;
  test.beforeAll(async ({ browser }) => { manager = await signInAgain(browser, 'Practice manager'); });

  test('the Dhanmondi front desk sees only its own clinic, in English, with Bangla calls', async ({ browser }) => {
    const page = await openAs(browser, 'dhanmondi');
    await expect(page.getByText('Dhanmondi Diagnostic Centre').first()).toBeVisible();
    await expect(page.getByText(/times are .*\(Asia\/Dhaka\)/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible(); // the dashboard stays in English
    await expect(page.getByText('Maple Street Family Medicine')).toHaveCount(0);

    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(6);
    await page.getByRole('tab', { name: 'Bookings and changes' }).click();
    await page.locator('tbody tr').first().getByRole('link').click();
    await expect(page).toHaveURL(/\/calls\/[^/]+$/);
    // what the caller said, in Bengali script, in the Bengali font
    const line = page.getByText(/রহিমা|তাহমিনা|Tahmina/).first();
    await expect(line).toBeVisible();

    // another organization's clinic is not there, even by its address
    const other = await page.request.get('/api/v1/clinics/clinic_demo_maple/settings');
    expect([403, 404]).toContain(other.status());
    await page.goto('/c/clinic_demo_maple');
    await expect(page.getByText('Maria Delgado')).toHaveCount(0);
  });

  test('Maple Street\'s manager cannot open Dhanmondi', async () => {
    const res = await manager.request.get('/api/v1/clinics/clinic_demo_dhanmondi/settings');
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

    // Bangla on: the preview appears, marked experimental
    await page.getByRole('checkbox', { name: /Bangla/ }).click();
    await expect(page.getByText('Experimental', { exact: true })).toBeVisible();
    await expect(page.getByText('Check the voice with a native speaker before using it with patients.')).toBeVisible();
    await expect(page.getByTestId('greeting-preview-bn')).toContainText('আমি Lena, এখানকার এআই সহকারী');
    await page.getByRole('checkbox', { name: /Bangla/ }).click();

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
});
