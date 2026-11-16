import { expect, test } from '@playwright/test';
import { openAs } from './session';

test('a manager makes an API key, sees it once, and revokes it', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings/api-keys`);
  const docs = page.getByRole('link', { name: 'How to connect an MCP client' });
  await expect(docs).toHaveAttribute('href', 'https://github.com/Elegant-IT-Limited/attendra/blob/main/docs/mcp.md');
  await expect(docs).toHaveAttribute('target', '_blank');
  await page.getByLabel('Name').fill('Desktop MCP client at the front desk');
  await page.getByRole('checkbox', { name: /Read requests/ }).click();
  await page.getByRole('button', { name: 'Make key' }).click();
  const value = (await page.getByTestId('api-key-value').textContent())!;
  expect(value).toMatch(/^atk_[A-Za-z0-9_-]{43}$/);
  await page.getByRole('button', { name: 'Done' }).click();
  const row = page.getByTestId('api-key').filter({ hasText: 'Desktop MCP client at the front desk' });
  await expect(row).toContainText('schedule:read');
  await expect(row).toContainText('requests:read');
  await expect(row).toContainText('Active');
  await expect(page.getByText(value)).toHaveCount(0); // never shown again
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toContainText('Revoked');
});

test('a manager makes a read-only key for the daily call export, and is told where it reads', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings/api-keys`);
  await expect(page.getByRole('link', { name: 'How the daily call export works' })).toHaveAttribute('href', 'https://github.com/Elegant-IT-Limited/attendra/blob/main/docs/qa-export.md');
  const scope = page.getByRole('checkbox', { name: /Daily call export for quality review/ });
  await expect(page.getByText('Read-only daily export of calls for quality review', { exact: false })).toBeVisible();
  await page.getByLabel('Name').fill('QA reviewer');
  // only the export: the default schedule scope off, the export on
  await page.getByRole('checkbox', { name: /Read the schedule/ }).click();
  await scope.click();
  await page.getByRole('button', { name: 'Make key' }).click();
  await expect(page.getByTestId('api-key-value')).toHaveText(/^atk_/);
  await expect(page.getByTestId('qa-export-how')).toContainText(`/api/v1/clinics/${clinic}/qa/export?day=YYYY-MM-DD`);
  await page.getByRole('button', { name: 'Done' }).click();
  const row = page.getByTestId('api-key').filter({ hasText: 'QA reviewer' });
  await expect(row).toContainText('qa:read');
  await expect(row).not.toContainText('schedule:read');
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toContainText('Revoked');
});
