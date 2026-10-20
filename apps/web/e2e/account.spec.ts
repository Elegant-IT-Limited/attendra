import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { openAs, signInPatiently } from './session';

/** The 6-digit code an authenticator app shows now for a base32 secret (RFC 6238: SHA-1, 30 seconds). */
function totp(secret: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.replace(/=+$/, '').toUpperCase()].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hash = createHmac('sha1', key).update(counter).digest();
  const offset = hash[hash.length - 1]! & 0xf;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('a new team member picks a password, changes it from Your account, turns on two-step, and is let back in after losing the phone', async ({ browser }) => {
  // two people and a dozen pages, each compiled on first use by next dev
  test.slow();
  const manager = await openAs(browser, 'manager');
  await manager.getByRole('link', { name: 'Team' }).click();
  await manager.getByRole('button', { name: 'Add a person' }).click();
  const dialog = manager.getByRole('dialog', { name: 'Add a person' });
  await dialog.getByLabel('Name').fill('Sam Reed');
  await dialog.getByLabel('Email').fill('sam@maple-demo.test');
  await dialog.getByLabel('Role').selectOption({ label: 'Front desk' });
  await dialog.getByRole('button', { name: 'Add to the team' }).click();
  const added = manager.getByRole('dialog', { name: 'Sam Reed is on the team' });
  const temporary = (await added.getByTestId('temporary-password').textContent())!;
  await added.getByRole('button', { name: 'Done' }).click();

  // the first sign-in: their own password before anything else
  const sam = await (await browser.newContext()).newPage();
  await sam.goto('/sign-in');
  await sam.getByLabel('Email').fill('sam@maple-demo.test');
  await sam.getByLabel('Password').fill(temporary);
  await signInPatiently(sam, () => sam.getByRole('button', { name: 'Sign in', exact: true }).click());
  await expect(sam).toHaveURL(/\/change-password$/, { timeout: 20_000 });
  await sam.getByLabel('Temporary password').fill(temporary);
  await sam.getByLabel('New password', { exact: true }).fill('sam picks a long one');
  await sam.getByLabel('New password again').fill('sam picks a long one');
  await sam.getByRole('button', { name: 'Save my password' }).click();
  await expect(sam.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();

  // Your account, from the menu: a new password of their own choosing
  await sam.getByRole('button', { name: 'Sam Reed, Front desk: account and theme' }).click();
  await sam.getByRole('menuitem', { name: /Your account/ }).click();
  await expect(sam.getByRole('heading', { name: 'Your account' })).toBeVisible({ timeout: 20_000 });
  await sam.getByRole('link', { name: 'Change your password' }).click();
  await expect(sam.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  await sam.getByLabel('Current password').fill('sam picks a long one');
  await sam.getByLabel('New password', { exact: true }).fill('sam picks another one');
  await sam.getByLabel('New password again').fill('sam picks another one');
  await sam.getByRole('button', { name: 'Save my password' }).click();
  await expect(sam.getByText('Your password is changed.', { exact: false })).toBeVisible();

  // two-step sign-in, turned on from Your account with a code from the "app"
  await sam.getByRole('link', { name: 'Turn it on' }).click();
  await sam.getByLabel('Confirm your password').fill('sam picks another one');
  await sam.getByRole('button', { name: 'Continue' }).click();
  const secret = (await sam.locator('code.font-mono').textContent())!.trim();
  await sam.getByLabel('Code from the app').fill(totp(secret));
  await sam.getByRole('button', { name: 'Turn on and continue' }).click();
  await expect(sam.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await sam.goto('/profile');
  await expect(sam.getByText('On: you sign in with your password and a code', { exact: false })).toBeVisible();
  await sam.getByRole('button', { name: 'New backup codes' }).click();
  await sam.getByLabel('Your password, for new backup codes').fill('sam picks another one');
  await sam.getByRole('button', { name: 'Continue' }).click();
  await expect(sam.getByText('Your new backup codes')).toBeVisible();

  // a lost phone: the manager resets two-step sign-in, and Sam is signed out everywhere
  await manager.reload();
  await manager.getByRole('row', { name: /Sam Reed/ }).getByRole('button', { name: 'Reset two-step' }).click();
  await manager.getByRole('dialog', { name: 'Reset Sam Reed\'s two-step sign-in?' }).getByRole('button', { name: 'Reset two-step' }).click();
  await expect(manager.getByText('Sam Reed can sign in with their password now', { exact: false })).toBeVisible();
  // the page may already be on its way to sign-in by itself: only the start of this navigation is awaited
  await sam.goto('/', { waitUntil: 'commit' });
  await expect(sam).toHaveURL(/\/sign-in/);
  // back in with the password alone (two-step is optional in the demo; in production they set it up again next)
  await sam.getByLabel('Email').fill('sam@maple-demo.test');
  await sam.getByLabel('Password').fill('sam picks another one');
  await signInPatiently(sam, () => sam.getByRole('button', { name: 'Sign in', exact: true }).click());
  await expect(sam.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
});

test('signing in again after the session ended opens the page you were on', async ({ browser }) => {
  const today = await openAs(browser, 'frontdesk');
  const schedule = `${new URL(today.url()).pathname}/schedule`;
  // the session ends (here: its cookie is gone). Today is closed first: its next refresh would
  // send it to sign-in by itself, racing the page opened here (net::ERR_ABORTED in CI)
  const context = today.context();
  await today.close();
  await context.clearCookies();
  const page = await context.newPage();
  await page.goto(schedule, { waitUntil: 'commit' });
  await expect(page).toHaveURL(/\/sign-in\?expired=1&next=/);
  await expect(page.getByText('You were signed out. Sign in again to carry on where you were.')).toBeVisible();
  await signInPatiently(page, () => page.getByRole('button', { name: 'Front desk', exact: true }).click());
  await expect(page).toHaveURL(new RegExp(`${schedule}$`), { timeout: 20_000 });
});

test('a wrong password says so, and a forgotten one is sent to the manager when no email is set up', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('nobody@maple-demo.test');
  await page.getByLabel('Password').fill('not the password at all');
  await signInPatiently(page, () => page.getByRole('button', { name: 'Sign in', exact: true }).click());
  await expect(page.getByText('That email and password do not match. Check them and try again.')).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue('nobody@maple-demo.test');
  await page.goto('/forgot-password');
  await expect(page.getByText('Your practice owner or manager can give you a new password on the Team page.', { exact: false })).toBeVisible();
  await page.goto('/reset-password');
  await expect(page.getByRole('link', { name: /new one|new link/i }).first()).toBeVisible();
});

test('a sign-in page opened while signed in, in another tab or after a reload, goes straight on', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinicPage = new URL(page.url()).pathname;
  await page.goto(`/sign-in?expired=1&next=${encodeURIComponent(`${clinicPage}/requests`)}`);
  await expect(page).toHaveURL(new RegExp(`${clinicPage}/requests$`), { timeout: 20_000 });
  await page.goto('/sign-in');
  await expect(page).toHaveURL(/\/c\/[^/]+/, { timeout: 20_000 });
});
