// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { phone } from '../lib/format';
import { openAs } from './session';

// Note 2026-11-16 N1: the two numbers a clinic has are named the same everywhere: "Assistant number" (calls are
// forwarded to it) and "Clinic's own line" (set in Setup), or "Not set". Settings > Phone numbers shows each by its
// name, with the number the server has. Nothing here is saved.
test('Settings > Phone numbers names the assistant number and the clinic\'s own line, with the server\'s numbers', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  const settings = (await (await page.request.get(`/api/v1/clinics/${clinic}/settings`)).json()) as { phoneNumbers: string[] };
  const meta = (await (await page.request.get(`/api/v1/clinics/${clinic}/settings/meta`)).json()) as { assistantNumbers?: string[] };
  const assistant = meta.assistantNumbers ?? [];
  const own = settings.phoneNumbers.filter((n) => n && !assistant.includes(n));
  await page.goto(`/c/${clinic}/settings`);
  const numbers = page.locator('#numbers');
  await expect(numbers.getByText(/^Assistant number: where calls reach the assistant/)).toBeVisible();
  for (const n of assistant.filter((x) => settings.phoneNumbers.includes(x))) {
    const row = numbers.getByRole('listitem').filter({ hasText: phone(n) ?? n });
    await expect(row).toContainText('Assistant number: calls to it reach the assistant');
  }
  const lines = numbers.getByLabel('Clinic\'s own line', { exact: true });
  await expect(lines).toHaveCount(own.length);
  for (const [i, n] of own.entries()) await expect(lines.nth(i)).toHaveValue(phone(n) ?? n);
  if (own.length) await expect(numbers.getByText('Clinic\'s own line: forward it to the assistant number').first()).toBeVisible();
  else await expect(numbers.getByTestId('own-line-not-set')).toHaveText('Clinic\'s own line: Not set');
  // the old names are gone
  await expect(numbers.getByText(/Your assistant's number|Your clinic's own line|Main number/)).toHaveCount(0);
});
