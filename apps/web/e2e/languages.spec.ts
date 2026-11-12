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
    // the Spanish greeting is editable, prefilled with the suggestion until the clinic writes its own
    const spanish = page.getByTestId('greeting-preview-es').getByRole('textbox');
    await expect(spanish).toHaveValue(/Soy Maya, la asistente virtual/);

    await name.fill('Lena');
    await expect(spanish).toHaveValue(/Soy Lena, la asistente virtual/);
    // the greeting follows the new name before saving (note 52 B3), and says so
    await expect(page.getByLabel('Greeting')).toHaveValue("Thanks for calling Maple Street Family Medicine. I'm Lena, the clinic's AI assistant. How can I help you today?");
    await expect(page.getByTestId('greeting-followed')).toHaveText('The greeting now says the new name. Read it, then save.');
    await expect(page.getByTestId('greeting-preview-en')).toContainText("I'm Lena");

    // a name is not a disclosure
    await page.getByLabel('Greeting').fill("Thanks for calling Maple Street. I'm Lena. How can I help?");
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('dialog', { name: 'Not saved. Fix these first' }).getByText('the greeting must disclose that the caller is speaking with an AI assistant')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();

    await page.getByRole('button', { name: 'Use the suggested greeting' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. The next call uses these settings.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Assistant name')).toHaveValue('Lena');

    await expect(page.getByLabel('Greeting')).toHaveValue(/I'm Lena, the clinic's AI assistant/);

    // put the demo back as it was for the specs after this one: the saved greeting follows the name back
    await page.getByLabel('Assistant name').fill('Maya');
    await expect(page.getByLabel('Greeting')).toHaveValue("Thanks for calling Maple Street Family Medicine. I'm Maya, the clinic's AI assistant. How can I help you today?");
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. The next call uses these settings.')).toBeVisible();
  });

  test('a greeting that still says an old name is pointed out, with a one-click change (note 52 B3)', async () => {
    const page = manager;
    await page.goto('/c/clinic_demo_maple/settings');
    const greeting = page.getByLabel('Greeting');
    await expect(greeting).toHaveValue(/I'm Maya/);
    await expect(page.getByTestId('greeting-stale-en')).toHaveCount(0);
    // a greeting written for an older clinic name and an older assistant name
    await greeting.fill("Thanks for calling Riverside Pet Care. I'm Ana, the clinic's AI assistant. How can I help you today?");
    await expect(page.getByTestId('greeting-stale-en')).toContainText('Your English greeting still says "Riverside Pet Care" and "Ana".');
    await page.getByTestId('greeting-stale-en').getByRole('button', { name: 'Change it to "Maple Street Family Medicine" and "Maya"' }).click();
    await expect(greeting).toHaveValue("Thanks for calling Maple Street Family Medicine. I'm Maya, the clinic's AI assistant. How can I help you today?");
    await expect(page.getByTestId('greeting-stale-en')).toHaveCount(0);
    // and a rename moves it on to the new name, before saving
    await page.getByLabel('Clinic name').fill('Maple Street Vets');
    await expect(page.getByTestId('greeting-stale-en')).toHaveCount(0);
    await expect(greeting).toHaveValue(/Thanks for calling Maple Street Vets\./);
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(greeting).toHaveValue(/Thanks for calling Maple Street Family Medicine\./);
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
