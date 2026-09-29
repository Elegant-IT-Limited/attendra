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
});
