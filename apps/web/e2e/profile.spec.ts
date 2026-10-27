import AxeBuilder from '@axe-core/playwright';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

const ORIGIN = 'http://localhost:3000';
const NAME = 'Priya (practice manager)';

/** A small made-up PNG, wider than it is tall, so the browser has a square to cut: 6 by 4 pixels of one colour. */
function png(width = 6, height = 4) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5a)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** The demo login as it was: its name and no picture, whatever the test got to. */
async function putBack(page: Page) {
  await page.request.patch('/api/v1/me', { data: { name: NAME }, headers: { origin: ORIGIN } });
  await page.request.delete('/api/v1/me/avatar', { headers: { origin: ORIGIN } });
}

test('Your profile: a new name shows in the sidebar and on Team, a picture shows and goes, and the email is read only', async ({ browser }) => {
  test.slow();
  const page = await openAs(browser, 'manager');
  const dashboard = page.url();
  try {
    await page.getByRole('button', { name: /account and theme/ }).click();
    await page.getByRole('menuitem', { name: 'Your profile' }).click();
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible({ timeout: 20_000 });

    // the email is shown, never as a box to type in; the role, one line per clinic
    await expect(page.getByText('Signed in as manager@maple-demo.test')).toBeVisible();
    await expect(page.getByText('To use a different email, write to us.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /email/i })).toHaveCount(0);
    await expect(page.getByText('Practice manager at Maple Street Family Medicine')).toBeVisible();

    // a name too short is said under the field, and nothing is saved
    await page.getByLabel('Your name').fill('P');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Write at least 2 characters.')).toBeVisible();
    await page.getByLabel('Your name').fill('Priya Nandan');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    // a picture: made small in the browser, and shown at once
    await expect(page.locator('[data-avatar="initials"]')).toBeVisible();
    await page.locator('#picture-file').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: png() });
    await expect(page.locator('img[data-avatar="picture"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();

    // the sidebar and Team, with the new name and the picture
    await page.goto(dashboard);
    const account = page.getByRole('button', { name: 'Priya Nandan, Practice manager: account and theme' });
    await expect(account).toBeVisible();
    await expect(account.locator('img[data-avatar="picture"]')).toBeVisible();
    await page.getByRole('link', { name: 'Team' }).click();
    const row = page.getByRole('row', { name: /Priya Nandan/ });
    await expect(row).toBeVisible();
    await expect(row.locator('img[data-avatar="picture"]')).toBeVisible();

    // removed: the initials are back, in the profile and in the sidebar
    await page.goto('/profile');
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Picture removed. Your initials show instead.')).toBeVisible();
    await expect(page.locator('[data-avatar="initials"]')).toBeVisible();
    await page.goto(dashboard);
    await expect(account.locator('[data-avatar="initials"]')).toBeVisible();
  } finally {
    await putBack(page);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`Your profile passes axe, ${theme}`, async ({ browser }) => {
    const page = await openAs(browser, 'frontdesk');
    await page.evaluate((t) => localStorage.setItem('attendra.theme', t), theme);
    await page.goto('/profile');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByText('Signed in as')).toBeVisible({ timeout: 20_000 });
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').analyze();
    expect(result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
}
