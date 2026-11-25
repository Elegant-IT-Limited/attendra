import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import { newContext, openAs } from './session';

// Fix batch 2026-11-26: every page says which build it is (VERSION), an unknown address is a branded page with a way
// back (QA-1107-1), and the short addresses (/today, /calls, ...) open that page of the last clinic, after sign-in
// when signed out (QA-1109-2). Values are checked against the server and against git.
type Version = { version: string; build: number | null; commit: string; dirty: boolean | null };
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const footerText = (v: Version) => `v${v.version} · build ${v.build ?? 'unknown'} · ${v.commit}${v.dirty ? ' · dirty' : ''}`;
const versionOf = async (page: Page) => (await (await page.request.get('/api/v1/version')).json()) as Version;
const SIZES = [{ name: 'desktop', width: 1280, height: 800 }, { name: 'tablet', width: 768, height: 1024 }, { name: 'phone', width: 390, height: 844 }];
const SHOTS = process.env.E2E_SHOTS_DIR;
async function shots(page: Page, name: string) {
  if (!SHOTS) return;
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.screenshot({ path: `${SHOTS}/${name}-${s.name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe('VERSION', () => {
  test('VERSION: the footer on the sign-in page and on Today shows the API\'s version, build and commit, which is git HEAD', async ({ browser }) => {
    const signedOut = await (await newContext(browser)).newPage();
    await signedOut.goto('/sign-in');
    const v = await versionOf(signedOut);
    expect(v.commit).toBe(git('rev-parse', '--short', 'HEAD'));
    expect(v.build).toBe(Number(git('rev-list', '--count', 'HEAD')));
    await expect(signedOut.getByTestId('app-version')).toHaveText(footerText(v));
    await shots(signedOut, 'version-sign-in');

    const page = await openAs(browser, 'manager');
    await expect(page.getByTestId('app-version')).toHaveText(footerText(v));
    await expect(page.getByTestId('app-version')).toHaveCount(1);
    await shots(page, 'version-today');
    // and on another page of the clinic
    await page.goto(`${new URL(page.url()).pathname}/calls`);
    await expect(page.getByTestId('app-version')).toHaveText(footerText(v));
  });
});

test.describe('QA-1107-1', () => {
  test('QA-1107-1: an unknown address is a branded page with one sentence and a way back to the dashboard', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    const res = await page.goto('/no-such-page-anywhere/really');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByText('This page does not exist. It may have moved, or the link has a typo.')).toBeVisible();
    // never the framework's bare page
    await expect(page.getByText('This page could not be found.')).toHaveCount(0);
    const back = page.getByRole('link', { name: 'Back to the dashboard' });
    await expect(back).toBeVisible();
    await expect(page.getByTestId('app-version')).toBeVisible();
    await shots(page, 'not-found-signed-in');
    await back.click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/);
  });

  test('QA-1107-1: signed out, the page offers sign-in instead', async ({ browser }) => {
    const page = await (await newContext(browser)).newPage();
    const res = await page.goto('/c/x/y/no-such-page');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    const signIn = page.getByRole('link', { name: 'Sign in' });
    await expect(signIn).toBeVisible();
    await shots(page, 'not-found-signed-out');
    await signIn.click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe('QA-1109-2', () => {
  const PAGES: [string, string][] = [['today', ''], ['calls', '/calls'], ['schedule', '/schedule'], ['requests', '/requests'], ['patients', '/patients'], ['settings', '/settings']];

  test('QA-1109-2: signed in, each short address opens that page of the clinic last opened', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    const clinic = new URL(page.url()).pathname.split('/')[2]!;
    for (const [short, path] of PAGES) {
      await page.goto(`/${short}`);
      await expect(page, short).toHaveURL(new RegExp(`/c/${clinic}${path}$`));
    }
  });

  test('QA-1109-2: signed out, a short address goes to sign-in, then to that page of the last clinic', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    for (const [short] of PAGES) {
      const res = await page.goto(`/${short}`);
      expect(res?.status(), short).toBe(200);
      await expect(page, short).toHaveURL(new RegExp(`/sign-in\\?next=%2F${short}$`));
      // no "your session ended": they were never signed in
      await expect(page.getByText(/session ended/i)).toHaveCount(0);
    }
    await page.goto('/schedule');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fschedule$/);
    await page.getByRole('button', { name: 'Practice manager', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[^/]+\/schedule$/, { timeout: 30_000 });
  });
});
