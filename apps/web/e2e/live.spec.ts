import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openAs } from './session';

// A simulated call: scripted, through the real assistant and the demo database, with
// no audio and no OpenAI. The demo server runs with ATTENDRA_SIMULATED_CALLS=on.
test('watch a live call, coach the assistant, and end it; the page becomes the call record', async ({ browser }) => {
  // a whole simulated call, axe in two themes, Today twice and the record: a long journey
  test.slow();
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/test-call`);
  await page.getByRole('button', { name: 'Play a simulated call' }).click();
  await expect(page).toHaveURL(/\/calls\/[^/]+\/live$/, { timeout: 20_000 });

  // captions, the tool steps, the verified caller, and the read-back waiting for a yes
  const captions = page.getByRole('log', { name: 'Live captions' });
  await expect(captions).toContainText('Maria Delgado', { timeout: 20_000 });
  await expect(page.getByText('Verified: Maria D.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('list', { name: 'Tool steps' })).toContainText('Identity check');
  const pending = page.getByTestId('pending-readback');
  await expect(pending).toContainText('Dr. Nkem Okafor', { timeout: 20_000 });
  await expect(captions).toContainText('Is that right?');

  // a browser test call cannot be taken over
  await expect(page.getByRole('button', { name: 'Take over' })).toBeDisabled();

  // the live page passes axe in both themes; a reload reconnects and replays the call so far
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('attendra.theme', t), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(pending).toBeVisible({ timeout: 20_000 });
    await expect(captions).toContainText('Maria Delgado');
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').analyze();
    expect(result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${theme}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
  }
  await page.evaluate(() => localStorage.setItem('attendra.theme', 'light'));

  // Today shows it under Live now
  const today = await page.context().newPage();
  await today.goto(`/c/${clinic}`);
  const strip = today.getByRole('list', { name: 'Live calls' });
  await expect(strip).toContainText('Verified: Maria D.', { timeout: 20_000 });
  await expect(strip).toContainText('Waiting for a yes');
  // and not as a call that ended with nothing done: it has not ended
  const callId = new URL(page.url()).pathname.split('/')[4];
  await expect(today.getByRole('list', { name: 'Needs attention' })).toBeVisible(); // shown once the calls have loaded
  await expect(today.locator(`a[href$="/calls/${callId}"]`).filter({ hasText: 'Open the call' })).toHaveCount(0);
  await today.close();

  await page.getByLabel('Note for the assistant').fill('she is a new patient, offer Thursday afternoon');
  await page.getByRole('button', { name: 'Send note' }).click();
  await expect(page.getByText('Note sent to the assistant.')).toBeVisible();
  // everyone watching sees the note, with who sent it, in the timeline
  const noteStep = page.getByTestId('staff-step').filter({ hasText: 'Note from Jordan (front desk)' });
  await expect(noteStep).toContainText('she is a new patient, offer Thursday afternoon');

  await page.getByRole('button', { name: 'End call' }).click();
  await page.getByRole('dialog', { name: 'End this call?' }).getByRole('button', { name: 'End the call' }).click();
  await expect(page.getByTestId('staff-step').filter({ hasText: 'Jordan (front desk) ended the call' })).toBeVisible();
  await expect(captions).toContainText('goodbye', { timeout: 10_000 });
  // the stream ends, and the page turns into the call record without a reload
  await expect(page).toHaveURL(/\/calls\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByText('Browser test').first()).toBeVisible();
  await expect(page.getByText('Ended by staff')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible();
  await expect(page.getByText('she is a new patient')).toHaveCount(0); // the note is never in the record
  // the summary appears when the worker has written it, with no reload
  await expect(page.getByTestId('call-summary')).toBeVisible({ timeout: 30_000 });
  // a browser test is not counted on Today, and not listed there either
  const record = new URL(page.url()).pathname;
  await page.goto(record.split('/calls/')[0]!);
  await expect(page.getByRole('list', { name: 'Recent calls' })).toBeVisible();
  await expect(page.locator(`a[href="${record}"]`)).toHaveCount(0);
});

test('a live page whose stream closes for good, for a call no longer live, becomes the call record', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  const callId = '00000000-0000-4000-8000-00000000c0de';
  const snapshot = { callId, channel: 'phone', startedAt: new Date(Date.now() - 60_000).toISOString(), verified: null, doing: null, waitingForYes: false, emergency: false, pending: null };
  let streams = 0;
  // the stream answers once, then refuses, so EventSource gives up; the call is not in the live list
  await page.route((url) => url.pathname === `/api/v1/clinics/${clinic}/calls/${callId}/live`, (route) => (streams++ === 0
    ? route.fulfill({ status: 200, contentType: 'text/event-stream', body: `id: 0\nevent: snapshot\ndata: ${JSON.stringify({ state: snapshot })}\n\n` })
    : route.fulfill({ status: 500, body: 'gone' })));
  await page.route((url) => url.pathname === `/api/v1/clinics/${clinic}/live`, (route) => route.fulfill({ json: { calls: [], counts: { live: 0, emergencies: 0 } } }));
  await page.goto(`/c/${clinic}/calls/${callId}/live`);
  await expect(page).toHaveURL(new RegExp(`/calls/${callId}$`), { timeout: 20_000 });
});

test('your own number for take-overs can be changed and cleared from the take-over dialog', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  const callId = '00000000-0000-4000-8000-00000000beef';
  const summary = { callId, channel: 'phone', startedAt: new Date(Date.now() - 60_000).toISOString(), verified: null, doing: null, waitingForYes: false, emergency: false };
  // a phone call, live: a browser test call cannot be taken over, so this one is stubbed
  await page.route((url) => url.pathname === `/api/v1/clinics/${clinic}/calls/${callId}/live`, (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream', body: `retry: 60000\nid: 0\nevent: snapshot\ndata: ${JSON.stringify({ state: { ...summary, pending: null } })}\n\n`,
  }));
  await page.route((url) => url.pathname === `/api/v1/clinics/${clinic}/live`, (route) => route.fulfill({ json: { calls: [summary], counts: { live: 1, emergencies: 0 } } }));
  let number: string | null = '+13035550123';
  const sent: unknown[] = [];
  await page.route((url) => url.pathname === `/api/v1/clinics/${clinic}/my-transfer-number`, async (route) => {
    if (route.request().method() === 'PUT') { const body = route.request().postDataJSON() as { number: string | null }; sent.push(body); number = body.number; }
    await route.fulfill({ json: { number } });
  });
  await page.goto(`/c/${clinic}/calls/${callId}/live`);
  await page.getByRole('button', { name: 'Take over' }).click();
  const dialog = page.getByRole('dialog', { name: 'Take over this call?' });
  await dialog.getByRole('radio', { name: /My own number/ }).click();
  await expect(dialog.getByText('+13035550123')).toBeVisible();
  await dialog.getByRole('button', { name: 'Change my number' }).click();
  await dialog.getByLabel('Your number').fill('+17205550188');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('+17205550188')).toBeVisible();
  await dialog.getByRole('button', { name: 'Clear it' }).click();
  await expect(dialog.getByText('Not set yet.')).toBeVisible();
  expect(sent).toEqual([{ number: '+17205550188' }, { number: null }]);
});
