import { expect, test } from '@playwright/test';
import { signInAgain } from './session';

test('a manager adds a staff member and changes their role; as a viewer they cannot open Patients', async ({ browser }) => {
  // dashboard.spec ends by signing the stored manager session out
  const page = await signInAgain(browser, 'Practice manager');
  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Priya \(practice manager\).*You/ })).toBeVisible();

  await page.getByRole('button', { name: 'Add a person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a person' });
  await dialog.getByLabel('Name').fill('Riley Stone');
  await dialog.getByLabel('Email').fill('riley@maple-demo.test');
  await dialog.getByLabel('Role').selectOption({ label: 'Front desk' });
  await dialog.getByRole('button', { name: 'Add to the team' }).click();
  const added = page.getByRole('dialog', { name: 'Riley Stone is on the team' });
  await expect(added.getByText('Shown once')).toBeVisible();
  const password = (await added.getByTestId('temporary-password').textContent())!;
  expect(password).toMatch(/^[\w-]{16}$/);
  await added.getByRole('button', { name: 'Done' }).click();

  const row = page.getByRole('row', { name: /Riley Stone/ });
  await expect(row.getByLabel('Role for Riley Stone')).toHaveValue('staff');
  await row.getByLabel('Role for Riley Stone').selectOption({ label: 'Viewer' });
  await expect(page.getByText('Riley Stone is now viewer.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByText('Changed someone\'s role to viewer').first()).toBeVisible();
  await expect(page.getByText('Added a person to the team, as front desk').first()).toBeVisible();

  // Riley signs in with the temporary password, as a viewer now
  const riley = await (await browser.newContext()).newPage();
  await riley.goto('/sign-in');
  await riley.getByLabel('Email').fill('riley@maple-demo.test');
  await riley.getByLabel('Password').fill(password);
  await riley.getByRole('button', { name: 'Sign in', exact: true }).click();
  // a temporary password is for one sign-in: Riley picks their own before anything else
  await expect(riley).toHaveURL(/\/change-password$/);
  await riley.getByLabel('Temporary password').fill(password);
  await riley.getByLabel('New password', { exact: true }).fill('riley picks a long one');
  await riley.getByLabel('New password again').fill('riley picks a long one');
  await riley.getByRole('button', { name: 'Save my password' }).click();
  await expect(riley.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(riley.getByRole('link', { name: 'Patients' })).toHaveCount(0);
  await riley.goto(`${new URL(riley.url()).pathname}/patients`);
  await expect(riley.getByText('Patients are for the front desk')).toBeVisible();
});
