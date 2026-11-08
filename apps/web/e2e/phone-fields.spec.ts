// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Locator, test } from '@playwright/test';
import { openAs } from './session';

// Note 14: every phone field takes numbers only. Batch 11-13 did the owner, vet, VIP, hospital, callback and "Call as"
// fields (patients.spec, test-call.spec); these are the ones that were left: the transfer numbers, the clinic's own
// lines, a vet's other numbers and the short emergency number. Nothing here is saved. Made-up 555 numbers only.
const NOTE = 'Use numbers only, for example (555) 555-0123.';

async function isPhoneField(field: Locator) {
  await expect(field).toHaveAttribute('type', 'tel');
  await expect(field).toHaveAttribute('inputmode', 'tel');
}

test('the phone fields left over take numbers only: letters typed or pasted are dropped, with a note', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings`);

  // a transfer number: letters go, with the note; a SIP address (letters and all) is still a transfer
  const transfers = page.locator('#transfers');
  await transfers.getByRole('button', { name: 'Transfer number', exact: true }).click();
  const transfer = transfers.getByLabel('Phone number').first();
  await isPhoneField(transfer);
  await transfer.fill('');
  await transfer.pressSequentially('720 FRONT');
  await expect(transfer).toHaveValue('720 ');
  await expect(transfers.getByText(NOTE)).toBeVisible();
  await transfer.fill('sip:desk@example.com'); // pasted at once
  await expect(transfer).toHaveValue('sip:desk@example.com');

  // the clinic's own line: a pasted number with letters keeps only the number
  const numbers = page.locator('#numbers');
  await numbers.getByRole('button', { name: "Your clinic's own line" }).click();
  const own = numbers.getByLabel("Your clinic's own line").last();
  await isPhoneField(own);
  await own.fill('(720) 555-01x9 call us');
  await expect(own).toHaveValue('(720) 555-019  ');
  await expect(numbers.getByText(NOTE)).toBeVisible();

  // the number a person in danger is told to call: digits only, and the hint says so
  const emergency = page.locator('#emergency-number');
  await emergency.fill('');
  await emergency.pressSequentially('9a1');
  await expect(emergency).toHaveValue('91');
  await expect(page.locator('#emergency-number-hint')).toContainText('Digits only, like 911.');

  // a vet's other numbers: several, separated by commas, each may start with +, and nothing else
  await page.goto(`/c/${clinic}/doctors`);
  await page.getByRole('button', { name: /^Add (doctor|vet)$/ }).click();
  const others = page.getByRole('dialog').getByLabel('Other numbers');
  await isPhoneField(others);
  await others.pressSequentially('+1 720 555 0101, 720 CALL 555 0102');
  await expect(others).toHaveValue('+1 720 555 0101, 720  555 0102');
  await expect(page.getByRole('dialog').getByText(NOTE)).toBeVisible();
});
