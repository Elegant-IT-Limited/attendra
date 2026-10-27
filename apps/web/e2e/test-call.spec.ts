import { expect, test } from '@playwright/test';
import { openAs } from './session';

// Never places a real call: the test-call request is answered here, whatever server runs.
test('front desk is told plainly when test calls are not set up', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk', (p) => p.route('**/api/v1/clinics/*/test-calls', (r) => r.fulfill({ status: 503, json: { error: 'voice_not_configured' } })));
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/test-call`);
  const start = page.getByRole('button', { name: 'Start test call' });
  // the demo without a key turns the page off; one with a key shows the button
  await expect(start.or(page.getByText('Test calls are off'))).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(page.getByText('Test calls are not set up on this server.')).toBeVisible();
  // a link to the guide, not a path in the repository to go and find
  await expect(page.getByText('docs/test-calls.md', { exact: false })).toHaveCount(0);
  if (!(await start.isVisible())) {
    await expect(page.getByRole('link', { name: 'How to set up test calls' })).toHaveAttribute('href', 'https://github.com/Elegant-IT-Limited/attendra/blob/main/docs/test-calls.md');
  }
});

// A simulated call: scripted, on the demo server, held by the clinic's frame like a browser test call.
test('a test call keeps going from Test call to Calls and back, with the call bar on every page', async ({ browser }) => {
  test.slow();
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  const live = async () => ((await (await page.request.get(`/api/v1/clinics/${clinic}/live`)).json()) as { calls: { callId: string }[] }).calls.map((c) => c.callId);
  await page.goto(`/c/${clinic}/test-call`);
  await page.getByRole('button', { name: 'Play a simulated call' }).click();
  await expect(page).toHaveURL(/\/calls\/[^/]+\/live$/, { timeout: 20_000 });
  const callId = new URL(page.url()).pathname.split('/')[4]!;
  const bar = page.getByRole('region', { name: 'Test call in progress' });
  await expect(bar).toContainText('Simulated call');

  // to Calls through the menu: the call goes on, and the bar shows there with its clock running
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calls', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/calls$`));
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('call-bar-status')).toHaveText(/^\d+:\d{2}$/);
  await expect(bar.getByTestId('call-bar-status')).not.toHaveText('0:00', { timeout: 5_000 });
  expect(await live()).toContain(callId);

  // and back to Test call from the bar: still the same call
  await bar.getByRole('link', { name: 'Back to Test call' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/test-call$`));
  await expect(bar).toBeVisible();
  expect(await live()).toContain(callId);

  // hang up from the bar: the bar goes, and so does the call
  await bar.getByRole('button', { name: 'Hang up' }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(live, { timeout: 30_000 }).not.toContain(callId);
});

// The record tick: ticked and kept by the clinic's frame while nothing is recording (a simulated call has no audio).
test('"Record this test call" can be ticked, and stays ticked from page to page until a call records', async ({ browser }) => {
  // the demo has no voice key: the page is told test calls are on, so it shows its own controls; no call is placed
  const page = await openAs(browser, 'frontdesk', (p) => p.route('**/api/v1/me', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), testCalls: true } });
  }));
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/test-call`);
  const tick = page.getByRole('checkbox', { name: 'Record this test call' });
  await expect(tick).toBeVisible();
  await expect(tick).not.toBeChecked();
  await expect(page.getByText('Saved as a file on this computer only. Nothing is uploaded.')).toBeVisible();
  await tick.click();
  await expect(tick).toBeChecked();
  // nothing records until a call is live
  await expect(page.getByTestId('recording-on')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Save the recording' })).toHaveCount(0);
  // the tick lives with the call, in the clinic's frame: still set after a visit to Calls
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calls', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/calls$`));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Test call', exact: true }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Record this test call' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Record this test call' }).click();
  await expect(page.getByRole('checkbox', { name: 'Record this test call' })).not.toBeChecked();
});
