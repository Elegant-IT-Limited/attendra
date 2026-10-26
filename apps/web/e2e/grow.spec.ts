import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

// a hosting layer's plan, with its links for an owner to grow
const plan = {
  plan: {
    status: 'active', includedMinutes: 500, periodStart: null, periodEnd: null, trialEndsAt: null, trialDays: 14, endsAt: null,
    manageUrl: '/account/billing', addLocationUrl: '/account/locations', newClinicUrl: '/account/new-clinic', notice: null, goLive: null,
  },
  minutesUsed: 0, textsUsed: 0,
};
const hosted = (p: Page) => p.route((u) => /^\/api\/v1\/clinics\/[^/]+\/plan$/.test(u.pathname), (route) => route.fulfill({ json: plan }));
// the demo has no owner login: the practice manager is shown as the owner (the API still checks every action itself)
const asOwner = (p: Page) => p.route((u) => u.pathname === '/api/v1/me', async (route) => {
  const res = await route.fetch();
  const me = await res.json();
  await route.fulfill({ response: res, json: { ...me, clinics: me.clinics.map((c: object) => ({ ...c, role: 'owner' })) } });
});

const accountMenu = (p: Page) => p.getByRole('button', { name: /account and theme/ }).first();

test('an owner on a hosted plan finds "Add a location" and "Create a new clinic" in the account menu', async ({ browser }) => {
  const page = await openAs(browser, 'manager', async (p) => { await hosted(p); await asOwner(p); });
  await accountMenu(page).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Add a location/ })).toHaveAttribute('href', '/account/locations');
  await expect(menu.getByRole('menuitem', { name: /Add a location/ })).toContainText('Same business, one bill');
  await expect(menu.getByRole('menuitem', { name: /Create a new clinic/ })).toHaveAttribute('href', '/account/new-clinic');
  await expect(menu.getByRole('menuitem', { name: /Create a new clinic/ })).toContainText('A separate business with its own plan');
});

test('staff see neither, and a self-hosted install shows them to nobody', async ({ browser }) => {
  const staff = await openAs(browser, 'frontdesk', hosted);
  await accountMenu(staff).click();
  await expect(staff.getByRole('menuitem', { name: /Sign out/ })).toBeVisible();
  await expect(staff.getByRole('menuitem', { name: /Add a location|Create a new clinic/ })).toHaveCount(0);

  // no plan at all: an owner sees nothing to buy
  const selfHosted = await openAs(browser, 'manager', asOwner);
  await accountMenu(selfHosted).click();
  await expect(selfHosted.getByRole('menuitem', { name: /Sign out/ })).toBeVisible();
  await expect(selfHosted.getByRole('menuitem', { name: /Add a location|Create a new clinic/ })).toHaveCount(0);
});
