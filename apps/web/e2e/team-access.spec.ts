import { type Browser, expect, type Page, test } from '@playwright/test';
import { newContext, openAs, signInAgain, signInPatiently } from './session';

/**
 * The invitation link and a login with no clinic (tester findings 2 and 6 of 2026-11-04, note
 * 39): the email opens that invitation's own page, signed out or in, for the right address or
 * another; a cancelled one says so; a login with no clinic is never a dead end. Made-up people.
 */

/** A new person the vet clinic's manager adds (the demo sends no email: a temporary password), signed in with their own password. */
async function newLogin(browser: Browser, email: string, name: string, password: string): Promise<Page> {
  const robin = await signInAgain(browser, 'Vet clinic manager');
  await robin.getByRole('link', { name: 'Team' }).click();
  await robin.getByRole('button', { name: 'Add people' }).click();
  const dialog = robin.getByRole('dialog', { name: 'Add people' });
  await dialog.getByLabel('Emails').fill(`${name} <${email}>`);
  await dialog.getByRole('button', { name: 'Add to the team' }).click();
  const sent = robin.getByRole('dialog', { name: 'Invites sent' });
  const temporary = (await sent.getByTestId('temporary-password').textContent())!;
  const page = await (await newContext(browser)).newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(temporary);
  await signInPatiently(page, () => page.getByRole('button', { name: 'Sign in', exact: true }).click());
  await expect(page).toHaveURL(/\/change-password$/, { timeout: 20_000 });
  await page.getByLabel('Temporary password').fill(temporary);
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('New password again').fill(password);
  await page.getByRole('button', { name: 'Save my password' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible({ timeout: 20_000 });
  return page;
}

/** Maple Street's manager invites an address that already has a login; its id, as the invited person's own list says. */
async function mapleInvites(browser: Browser, email: string, role: 'Front desk' | 'Viewer', invitee: Page) {
  const priya = await openAs(browser, 'manager');
  await priya.getByRole('link', { name: 'Team' }).click();
  await priya.getByRole('button', { name: 'Add people' }).click();
  const dialog = priya.getByRole('dialog', { name: 'Add people' });
  await dialog.getByLabel('Emails').fill(email);
  await dialog.getByLabel(`Role for ${email}`).selectOption({ label: role });
  await dialog.getByRole('button', { name: 'Add to the team' }).click();
  await expect(priya.getByRole('dialog', { name: 'Invites sent' }).getByText(`${email}: invite sent`)).toBeVisible();
  await priya.getByRole('dialog', { name: 'Invites sent' }).getByRole('button', { name: 'Done' }).click();
  const mine = await (await invitee.request.get('/api/v1/me/invitations')).json() as { invitations: { id: string; clinicName: string }[] };
  return { priya, id: mine.invitations.find((i) => i.clinicName.startsWith('Maple Street'))!.id };
}

test('the invitation link: signed out it signs in and comes back; another address is told so; accepting opens the clinic', async ({ browser }) => {
  test.slow();
  const vera = await newLogin(browser, 'vera@riverbend-demo.test', 'Vera Lin', 'vera picks a long one');
  const { priya, id } = await mapleInvites(browser, 'vera@riverbend-demo.test', 'Front desk', vera);

  // someone else signed in opens the link: nothing about the clinic, and a way to switch
  await priya.goto(`/invite/${id}`);
  await expect(priya.getByRole('heading', { name: 'This invitation is for another address' })).toBeVisible({ timeout: 20_000 });
  await expect(priya.getByTestId('invite-other-address')).not.toContainText('Maple');

  // signed out, the link asks to sign in for the invitation, then comes straight back to it
  const fresh = await (await newContext(browser)).newPage();
  await fresh.goto(`/invite/${id}`);
  await expect(fresh).toHaveURL(/\/sign-in\?invited=1/, { timeout: 20_000 });
  await expect(fresh.getByText('Sign in to answer your invitation')).toBeVisible();
  await fresh.getByLabel('Email').fill('vera@riverbend-demo.test');
  await fresh.getByLabel('Password').fill('vera picks a long one');
  await signInPatiently(fresh, () => fresh.getByRole('button', { name: 'Sign in', exact: true }).click());
  await expect(fresh).toHaveURL(new RegExp(`/invite/${id}$`), { timeout: 20_000 });
  await expect(fresh.getByTestId('invite-line')).toHaveText('Maple Street Family Medicine invited you as Front desk.');
  // what the role can do, from the same table the API checks
  await expect(fresh.getByText('Book, move and cancel visits')).toBeVisible();
  await fresh.getByRole('button', { name: 'Accept' }).click();
  await expect(fresh).toHaveURL(/\/c\/[^/]+$/, { timeout: 20_000 });
  await expect(fresh.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(fresh.getByRole('button', { name: /Maple Street Family Medicine, Front desk: switch clinic/ })).toBeVisible();

  // the same link later says it was accepted, with the way in
  await fresh.goto(`/invite/${id}`);
  await expect(fresh.getByRole('heading', { name: 'Already accepted' })).toBeVisible();
});

test('a cancelled invitation says so; a login with no clinic sees its invitations, or what to ask for', async ({ browser }) => {
  test.slow();
  const wes = await newLogin(browser, 'wes@riverbend-demo.test', 'Wes Hart', 'wes picks a long one');
  const { priya, id } = await mapleInvites(browser, 'wes@riverbend-demo.test', 'Viewer', wes);
  await priya.reload();
  await priya.getByTestId('invitations').getByRole('button', { name: 'Cancel the invitation to wes@riverbend-demo.test' }).click();
  await expect(priya.getByText('Invitation cancelled.')).toBeVisible();
  await wes.goto(`/invite/${id}`);
  await expect(wes.getByRole('heading', { name: 'Invitation cancelled' })).toBeVisible({ timeout: 20_000 });
  await expect(wes.getByTestId('invite-closed')).toContainText('Maple Street Family Medicine cancelled this invitation.');

  // Riverbend removes Wes: no clinic now, and a new invitation from Maple waits on the start page
  const robin = await signInAgain(browser, 'Vet clinic manager');
  await robin.getByRole('link', { name: 'Team' }).click();
  await robin.getByRole('row', { name: /Wes Hart/ }).getByRole('button', { name: 'Remove' }).click();
  await robin.getByRole('dialog', { name: /Remove Wes Hart/ }).getByRole('button', { name: 'Remove' }).click();
  await expect(robin.getByText('Wes Hart can no longer open Riverbend Animal Hospital.', { exact: false })).toBeVisible();

  const again = await (await newContext(browser)).newPage();
  await again.goto('/sign-in');
  await again.getByLabel('Email').fill('wes@riverbend-demo.test');
  await again.getByLabel('Password').fill('wes picks a long one');
  await signInPatiently(again, () => again.getByRole('button', { name: 'Sign in', exact: true }).click());
  await expect(again.getByTestId('no-clinic')).toBeVisible({ timeout: 20_000 });
  await expect(again.getByText('invite this email address', { exact: false })).toBeVisible();

  await mapleInvites(browser, 'wes@riverbend-demo.test', 'Viewer', again);
  await again.reload();
  await expect(again.getByRole('heading', { name: 'You have an invitation' })).toBeVisible({ timeout: 20_000 });
  await again.getByTestId('invitation').getByRole('button', { name: 'Accept' }).click();
  await expect(again.getByRole('heading', { name: 'Today', exact: true })).toBeVisible({ timeout: 20_000 });
});
