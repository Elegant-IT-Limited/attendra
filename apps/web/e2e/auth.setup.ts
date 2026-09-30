import { expect, test as setup } from '@playwright/test';
import { STATE } from './auth-state';

for (const [role, label] of [['manager', 'Practice manager'], ['frontdesk', 'Front desk'], ['dhanmondi', 'Dhanmondi front desk']] as const) {
  setup(`sign in as ${role}`, async ({ page }) => {
    await page.goto('/sign-in');
    // the form stays for every other login
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    // one click on a demo login signs in
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/); // the Today screen
    await page.context().storageState({ path: STATE[role] });
  });
}
