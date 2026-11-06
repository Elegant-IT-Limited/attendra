import { type Browser, expect, type Page, test } from '@playwright/test';
import { newContext, openAs, signInAgain, signInPatiently } from './session';

/**
 * Real time (batch 3): an invitation appears in the invited person's open tab without a
 * reload, a role change reaches the menu at once, and a stream that dropped catches up
 * on what it missed when it is back. Made-up people.
 */

/** A new person the vet clinic's manager adds as front desk (the demo sends no email: a temporary password), signed in with their own password. */
async function newLogin(browser: Browser, email: string, name: string, password: string) {
  const robin = await signInAgain(browser, 'Vet clinic manager');
  await robin.getByRole('link', { name: 'Team' }).click();
  await robin.getByRole('button', { name: 'Add people' }).click();
  const dialog = robin.getByRole('dialog', { name: 'Add people' });
  await dialog.getByLabel('Emails').fill(`${name} <${email}>`);
  await dialog.getByRole('button', { name: 'Add to the team' }).click();
  const sent = robin.getByRole('dialog', { name: 'Invites sent' });
  const temporary = (await sent.getByTestId('temporary-password').textContent())!;
  await sent.getByRole('button', { name: 'Done' }).click();
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
  return { page, robin };
}

/** Nothing on the page reloads: a marker set now is still there at the end. */
const mark = (page: Page) => page.evaluate(() => { (window as unknown as { stillHere: boolean }).stillHere = true; });
const stillHere = (page: Page) => page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere === true);

test('an invitation appears in the open tab within 3 seconds, and a role change reaches the menu at once', async ({ browser }) => {
  test.slow();
  const { page: nia, robin } = await newLogin(browser, 'nia@riverbend-demo.test', 'Nia Shore', 'nia picks a long one');
  await expect(nia.getByRole('link', { name: /^(Pets|Patients)$/ })).toBeVisible();
  await mark(nia);

  // Maple Street's manager invites the same address: it already has a login, so an invitation waits for Nia
  const priya = await openAs(browser, 'manager');
  await priya.getByRole('link', { name: 'Team' }).click();
  await priya.getByRole('button', { name: 'Add people' }).click();
  const dialog = priya.getByRole('dialog', { name: 'Add people' });
  await dialog.getByLabel('Emails').fill('nia@riverbend-demo.test');
  await dialog.getByLabel('Role for nia@riverbend-demo.test').selectOption({ label: 'Viewer' });
  await dialog.getByRole('button', { name: 'Add to the team' }).click();
  await expect(priya.getByRole('dialog', { name: 'Invites sent' }).getByText('nia@riverbend-demo.test: invite sent')).toBeVisible();
  const sentAt = Date.now();
  await expect(nia.getByText('Maple Street Family Medicine invited you as Viewer', { exact: false })).toBeVisible({ timeout: 3000 });
  test.info().annotations.push({ type: 'invitation shown', description: `${Date.now() - sentAt} ms after it was sent` });

  // Riverbend makes Nia a viewer: the menu loses the records at once, with no reload
  await robin.getByRole('row', { name: /Nia Shore/ }).getByLabel('Role for Nia Shore').selectOption({ label: 'Viewer' });
  await expect(robin.getByText('Nia Shore is now viewer', { exact: false })).toBeVisible();
  await expect(nia.getByRole('link', { name: /^(Pets|Patients)$/ })).toHaveCount(0, { timeout: 3000 });
  expect(await stillHere(nia)).toBe(true);
});

test('a stream that dropped catches up on what it missed when it is back', async ({ browser }, info) => {
  test.slow();
  const base = info.project.use.baseURL!;
  let clinicId = '';
  let firstId = '';
  let streams = 0;
  let release!: () => void;
  const changed = new Promise<void>((r) => { release = r; });
  // before the page loads: a real id from the server, for the browser's first stream, which then ends as a dropped connection does
  const desk = await openAs(browser, 'frontdesk', async (page) => {
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    clinicId = ((await (await fetch(`${base}/api/v1/me`, { headers: { cookie } })).json()) as { clinics: { id: string }[] }).clinics[0]!.id;
    const abort = new AbortController();
    const res = await fetch(`${base}/api/v1/clinics/${clinicId}/changes`, { headers: { cookie }, signal: abort.signal });
    const reader = res.body!.getReader();
    let text = '';
    while (!/id: \S+\nevent: ready\ndata: [^\n]*\n\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    firstId = /id: (\S+)\nevent: ready/.exec(text)![1]!;
    await page.route('**/api/v1/clinics/*/changes', async (route) => {
      streams++;
      if (streams === 1) return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `retry: 300\n\nid: ${firstId}\nevent: ready\ndata: {"missed":[]}\n\n` });
      // the browser comes back with the last id (Chromium adds Last-Event-ID below what the route sees); it waits here
      // until the change has been made, so the stream it opens subscribes after it: only the replay can bring it
      await changed;
      return route.continue();
    });
  });
  expect(desk.url()).toContain(`/c/${clinicId}`);
  await desk.getByRole('link', { name: 'Requests' }).click();
  await expect(desk.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible({ timeout: 20_000 });
  await mark(desk);
  await expect.poll(() => streams, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  // while it was away: the manager adds a request
  const priya = await openAs(browser, 'manager');
  const res = await priya.request.post(`/api/v1/clinics/${clinicId}/tasks`, {
    headers: { origin: new URL(base).origin }, data: { type: 'callback', topic: null, name: 'Juniper Vale', patientId: null, reason: 'asked about the stream test', callbackNumber: null, urgent: false, dueOn: null },
  });
  expect(res.ok()).toBe(true);
  release();
  // back: the first message says what was missed, and the list reads again, with no reload and no 2-minute wait
  await expect(desk.getByText('Juniper Vale').first()).toBeVisible({ timeout: 5000 });
  expect(await stillHere(desk)).toBe(true);
});
