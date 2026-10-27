import { expect, type Locator, test } from '@playwright/test';
import { signInAgain } from './session';

/** The one pet form, as Pets and a new booking's "New pet" step both show it. */
async function fillPet(form: Locator, pet: { name: string; birthday: string; owner: string; phone: string }) {
  await form.getByLabel('Pet\'s name').fill(pet.name);
  // a kind of animal is picked from the clinic's list, never typed in
  const species = form.getByRole('combobox', { name: 'Kind of animal' });
  await species.click();
  await form.page().getByRole('listbox', { name: 'Choices for kind of animal' }).getByRole('option', { name: 'Dog', exact: true }).click();
  await expect(species).toHaveValue('Dog');
  await form.getByLabel('Birthday').fill(pet.birthday);
  await form.getByLabel('Sex').selectOption({ label: 'Male' });
  await form.getByLabel('Owner\'s first name').fill(pet.owner);
  await form.getByLabel('Owner\'s phone').fill(pet.phone);
}

test.describe.serial('pets at a vet clinic', () => {
  test('an owner with one name saves from Pets; a birthday in the future is refused under the field', async ({ browser }) => {
    const page = await signInAgain(browser, 'Vet clinic manager');
    await page.getByRole('link', { name: 'Pets', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add pet' }).click();
    const form = page.getByRole('dialog', { name: 'Add pet' });
    await fillPet(form, { name: 'Juniper', birthday: '2099-01-01', owner: 'Wren', phone: '(720) 555-0177' });
    // the last name is optional, and says why
    await expect(form.getByText('Leave empty if they go by one name.')).toBeVisible();
    await form.getByRole('button', { name: 'Add pet' }).click();
    // under the field, not in a dialog
    await expect(form.getByText('A birthday can\'t be in the future.')).toBeVisible();
    await expect(form.getByLabel('Birthday')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('dialog', { name: 'Not saved' })).toHaveCount(0);
    await form.getByLabel('Birthday').fill('2024-05-01');
    await expect(form.getByText('A birthday can\'t be in the future.')).toBeHidden();
    await form.getByRole('button', { name: 'Add pet' }).click();
    await expect(page.getByRole('heading', { name: 'Juniper', exact: true })).toBeVisible();
    // an edit refuses it the same way, under the field, and the pet keeps its birthday
    await page.getByRole('tab', { name: 'Details' }).click();
    const details = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save changes' }) });
    await details.getByLabel('Birthday').fill('2099-01-01');
    await details.getByRole('button', { name: 'Save changes' }).click();
    await expect(details.getByText('A birthday can\'t be in the future.')).toBeVisible();
    await expect(details.getByLabel('Birthday')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('dialog', { name: 'Not saved' })).toHaveCount(0);
    await page.reload();
    await page.getByRole('tab', { name: 'Details' }).click();
    await expect(page.getByLabel('Birthday')).toHaveValue('2024-05-01');
  });

  test('on a phone the "kind of animal" filter is as wide as its longest choice', async ({ browser }) => {
    const page = await signInAgain(browser, 'Vet clinic manager');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${new URL(page.url()).pathname.split('/').slice(0, 3).join('/')}/patients`);
    const filter = page.getByRole('combobox', { name: 'Kind of animal' });
    await expect(filter).toHaveValue('');
    // the box is wider than "Any kind of animal" set in its own font, with room for the padding and the arrow
    const [box, text] = await filter.evaluate((el: HTMLSelectElement) => {
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = getComputedStyle(el).font;
      return [el.clientWidth, c.measureText('Any kind of animal').width];
    });
    expect(box).toBeGreaterThan(text + 40);
  });

  test('an owner with one name saves from a new booking\'s "New pet" step, and the pet is picked', async ({ browser }) => {
    const page = await signInAgain(browser, 'Vet clinic manager');
    await page.getByRole('link', { name: 'Schedule', exact: true }).first().click();
    await page.getByRole('button', { name: 'New booking' }).click();
    const dialog = page.getByRole('dialog', { name: 'New booking' });
    await dialog.getByRole('button', { name: 'Add a new pet' }).click();
    await fillPet(dialog, { name: 'Tansy', birthday: '2023-02-01', owner: 'Ash', phone: '(720) 555-0178' });
    await dialog.getByRole('button', { name: 'Add and continue' }).click();
    await expect(dialog.getByText('For Tansy', { exact: true })).toBeVisible();
  });
});
