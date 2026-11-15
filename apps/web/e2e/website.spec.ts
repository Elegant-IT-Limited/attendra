// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { openAs } from './session';

// 2026-11-16: Settings took "https://" off while it was typed, then refused the website for lacking it, so a new website
// could not be saved. One rule now: typed with or without https://, kept with it.
test('a website typed without https:// is saved with it, and https:// typed by hand stays', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  await page.goto('/c/clinic_demo_maple/settings');
  const website = page.getByLabel('Website');
  await expect(website).toHaveValue('');

  // typed key by key, the scheme is never taken off
  await website.pressSequentially('https://');
  await expect(website).toHaveValue('https://');
  await website.pressSequentially('maplestreet.example');
  await expect(website).toHaveValue('https://maplestreet.example');

  // without the scheme: kept as typed while typing, and with https:// once the field is left
  await website.fill('maplestreet.example/hours');
  await expect(website).toHaveValue('maplestreet.example/hours');
  await page.locator('#address').click();
  await expect(website).toHaveValue('https://maplestreet.example/hours');

  // and saved, even straight from the keyboard with the scheme left out
  await website.fill('maplestreet.example');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved. The next call uses these settings.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Website')).toHaveValue('https://maplestreet.example');

  // put the demo back: no website
  await page.getByLabel('Website').fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved. The next call uses these settings.').last()).toBeVisible();
  await expect(page.getByLabel('Website')).toHaveValue('');
});
