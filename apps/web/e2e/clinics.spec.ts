import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type BrowserContext, expect, type Page, request, test } from '@playwright/test';
import { STATE } from './auth-state';
import { openAs, signInAgain, signInPatiently } from './session';

// a hosting layer's plan, with its links for an owner to grow
const plan = {
  plan: {
    status: 'active', includedMinutes: 500, periodStart: null, periodEnd: null, trialEndsAt: null, trialDays: 14, endsAt: null,
    manageUrl: '/account/billing', addLocationUrl: '/account/locations', newClinicUrl: '/account/new-clinic', notice: null, goLive: null,
  },
  minutesUsed: 0, textsUsed: 0,
};
const hosted = (p: Page) => p.route((u) => /^\/api\/v1\/clinics\/[^/]+\/plan$/.test(u.pathname), (route) => route.fulfill({ json: plan }));
// the demo has no owner login: a manager is shown as the owner (the API still checks every action itself)
const asOwner = (p: Page) => p.route((u) => u.pathname === '/api/v1/me', async (route) => {
  const res = await route.fetch();
  const me = await res.json();
  await route.fulfill({ response: res, json: { ...me, clinics: me.clinics.map((c: object) => ({ ...c, role: 'owner' })) } });
});
const switcher = (p: Page) => p.getByRole('button', { name: /switch clinic/ });

test('an owner with one clinic still finds the switcher, with the two owner actions', async ({ browser }) => {
  const page = await openAs(browser, 'manager', async (p) => { await hosted(p); await asOwner(p); });
  await expect(switcher(page)).toHaveAccessibleName('Maple Street Family Medicine, Owner: switch clinic');
  await switcher(page).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Your clinics')).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(1);
  await expect(menu.getByRole('menuitemradio', { name: /Maple Street Family Medicine/ })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByText('For owners')).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Add a location/ })).toHaveAttribute('href', '/account/locations');
  await expect(menu.getByRole('menuitem', { name: /Create a new clinic/ })).toHaveAttribute('href', '/account/new-clinic');
});

test('past six clinics the menu has a search box, and typing narrows the list', async ({ browser }) => {
  // six more made-up clinics in the list (never opened: the API would not know them)
  const more = ['Oak Hollow Pet Care', 'Birch Lane Clinic', 'Cedar Point Vets', 'Elm Grove Health', 'Pine Ridge Animal Clinic', 'Willow Creek Family Practice'];
  const page = await openAs(browser, 'manager', (p) => p.route((u) => u.pathname === '/api/v1/me', async (route) => {
    const res = await route.fetch();
    const me = await res.json();
    await route.fulfill({ response: res, json: { ...me, clinics: [...me.clinics, ...more.map((name, i) => ({ ...me.clinics[0], id: `clinic_made_up_${i}`, name, role: 'staff' }))] } });
  }));
  await switcher(page).click();
  const find = page.getByRole('searchbox', { name: 'Find a clinic' });
  await expect(find).toBeFocused();
  await expect(page.getByRole('menuitemradio')).toHaveCount(7);
  await page.keyboard.type('cedar');
  await expect(page.getByRole('menuitemradio')).toHaveText([/Cedar Point Vets/]);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: /Cedar Point Vets/ })).toBeFocused();
  await find.fill('nothing like it');
  await expect(page.getByText('No clinic matches.')).toBeVisible();
});

test('front desk with one clinic sees just its name and their role, nothing to open', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk', hosted);
  const name = page.getByRole('complementary').getByTestId('clinic-name');
  await expect(name).toContainText('Maple Street Family Medicine');
  await expect(name).toContainText('Front desk');
  await expect(switcher(page)).toHaveCount(0);
});

// Robin, the vet clinic's manager, also joins Maple Street's front desk for these tests: one login, two clinics
// (Maple Street first in the list, Riverbend second). Put back as it was at the end.
let robin: BrowserContext;
let manager: APIRequestContext;
let maple = '';
let riverbend = '';
let robinId = '';

const json = async <T>(res: Promise<{ ok(): boolean; status(): number; json(): Promise<unknown> }>) => {
  const r = await res;
  expect(r.ok(), `status ${r.status()}`).toBe(true);
  return r.json() as Promise<T>;
};
// the API takes a change only from the dashboard's own address
const origin = { origin: 'http://localhost:3000' };
interface Me { user: { id: string }; clinics: { id: string; name: string }[] }

test.describe.serial('one login, two clinics', () => {
  test.beforeAll(async ({ browser }) => {
    // the manager's session, for the API only: it outlives every page these tests open
    manager = await request.newContext({ baseURL: 'http://localhost:3000', storageState: STATE.manager });
    maple = (await json<Me>(manager.get('/api/v1/me'))).clinics[0]!.id;
    await json(manager.post(`/api/v1/clinics/${maple}/members`, { headers: origin, data: { email: 'manager@riverbend-demo.test', role: 'staff' } }));
    const page = await signInAgain(browser, 'Vet clinic manager');
    robin = page.context();
    const me = await json<Me>(robin.request.get('/api/v1/me'));
    robinId = me.user.id;
    riverbend = me.clinics[0]!.id;
    const { invitations } = await json<{ invitations: { id: string }[] }>(robin.request.get('/api/v1/me/invitations'));
    await json(robin.request.post(`/api/v1/me/invitations/${invitations[0]!.id}/accept`, { headers: origin }));
    await page.close();
  });

  test.afterAll(async () => {
    if (robinId) expect((await manager.delete(`/api/v1/clinics/${maple}/members/${robinId}`, { headers: origin })).status()).toBe(204);
    await robin?.close();
    await manager?.dispose();
  });

  test('an owner sees every clinic with their role, the current one checked, and the two actions; picking one opens the same page there', async () => {
    const page = await robin.newPage();
    await hosted(page);
    await asOwner(page);
    await page.goto(`/c/${maple}/schedule`);
    await switcher(page).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio')).toHaveText([/Maple Street Family MedicineOwner$/, /Riverbend Animal HospitalOwner$/]);
    await expect(menu.getByRole('menuitemradio', { name: /Maple Street/ })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitem', { name: /Add a location/ })).toContainText('Same business, one bill');
    await expect(menu.getByRole('menuitem', { name: /Create a new clinic/ })).toContainText('A separate business with its own plan');
    await menu.getByRole('menuitemradio', { name: /Riverbend/ }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${riverbend}/schedule$`));
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByText('Now in Riverbend Animal Hospital.')).toBeVisible();
    await expect(switcher(page)).toHaveAccessibleName('Riverbend Animal Hospital, Owner: switch clinic');

    // the open menu, in light and dark, with no serious or critical accessibility issue
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => localStorage.setItem('attendra.theme', t), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await switcher(page).click();
      await expect(page.getByRole('menuitem', { name: /Create a new clinic/ })).toBeVisible();
      // judged once the menu has finished rising in: half way, its muted text is fainter than it ends up
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity));
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').analyze();
      expect(result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => localStorage.removeItem('attendra.theme'));
    await page.close();
  });

  test('staff see the list only, with their role at each clinic', async () => {
    const page = await robin.newPage();
    await hosted(page);
    await page.goto(`/c/${maple}`);
    await switcher(page).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio')).toHaveText([/Maple Street Family MedicineFront desk$/, /Riverbend Animal HospitalPractice manager$/]);
    await expect(menu.getByText('For owners')).toHaveCount(0);
    await expect(menu.getByRole('menuitem')).toHaveCount(0);
    await page.close();
  });

  test('the switcher works from the keyboard, and the command palette jumps to a clinic', async () => {
    const page = await robin.newPage();
    await page.goto(`/c/${maple}/requests`);
    await switcher(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape'); // closes, and focus goes back to the button
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(switcher(page)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: /Maple Street/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: /Riverbend/ })).toBeFocused();
    await page.keyboard.press('m'); // type-ahead, by the first letter of a name
    await expect(page.getByRole('menuitemradio', { name: /Maple Street/ })).toBeFocused();
    await page.waitForTimeout(1_100); // letters typed within a second are one search
    await page.keyboard.press('r');
    await expect(page.getByRole('menuitemradio', { name: /Riverbend/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/c/${riverbend}/requests$`));
    await expect(page.getByText('Now in Riverbend Animal Hospital.')).toBeVisible();

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const palette = page.getByRole('dialog', { name: 'Search and jump' });
    await palette.getByRole('combobox').fill('maple');
    await palette.getByRole('option', { name: /Maple Street Family Medicine/ }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${maple}/requests$`));
    await page.close();
  });

  test('on a phone the switcher opens as a sheet from the bottom', async () => {
    const page = await robin.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/c/${maple}`);
    await switcher(page).click();
    const sheet = page.getByRole('dialog', { name: 'Your clinics' });
    await expect(sheet.getByRole('button', { name: /Maple Street/ })).toHaveAttribute('aria-current', 'true');
    await sheet.getByRole('button', { name: /Riverbend/ }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${riverbend}$`));
    await expect(sheet).toHaveCount(0);
    await page.close();
  });

  test('the dashboard opens the clinic you were in, after another page and after signing in again', async () => {
    const page = await robin.newPage();
    // the first clinic, opened last: home opens it
    await page.goto(`/c/${maple}`);
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/c/${maple}$`));

    // the second one, then away (an account page, or Your account) and back home: still the second
    await page.goto(`/c/${riverbend}/schedule`);
    await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
    await page.goto('/profile');
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/c/${riverbend}$`));

    // signed out and in again in this browser: still the second
    await page.getByRole('button', { name: /account and theme/ }).first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await signInPatiently(page, () => page.getByRole('button', { name: 'Vet clinic manager', exact: true }).click());
    await expect(page).toHaveURL(new RegExp(`/c/${riverbend}$`));
    await page.close();
  });
});
