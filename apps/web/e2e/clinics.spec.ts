import { type APIRequestContext, type BrowserContext, expect, test } from '@playwright/test';
import { STATE } from './auth-state';
import { signInAgain, signInPatiently } from './session';

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
    const desk = await browser.newContext({ storageState: STATE.manager });
    manager = desk.request;
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
    if (robinId) await json(manager.delete(`/api/v1/clinics/${maple}/members/${robinId}`, { headers: origin }));
    await robin?.close();
    await manager?.dispose();
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
