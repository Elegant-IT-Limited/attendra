import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2];

test('the command palette finds Maria Delgado and opens her record', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const palette = page.getByRole('dialog', { name: 'Search and jump' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill('delg');
  await palette.getByRole('option', { name: /Maria Delgado/ }).click();
  await expect(page.getByRole('heading', { name: 'Maria Delgado' })).toBeVisible();
  await expect(page).not.toHaveURL(/delg/); // what was typed stays out of the address bar
});

test('keyboard shortcuts move between pages', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('r');
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('dark mode is a choice that sticks, and back to light', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const menu = () => page.getByRole('button', { name: /account and theme/ }).click();
  await menu();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // before first paint, from this browser
  await menu();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

// every main page, in light and dark, with no serious or critical accessibility issue
for (const theme of ['light', 'dark'] as const) {
  test(`accessibility, ${theme}`, async ({ browser }) => {
    test.setTimeout(120_000);
    // the manager sees every page, Team and the audit log included
    const page = await openAs(browser, 'manager');
    await page.evaluate((t) => localStorage.setItem('attendra.theme', t), theme);
    const c = clinicOf(page);
    const pages: [string, string, string][] = [
      ['Today', `/c/${c}`, 'Calls answered'],
      ['Schedule', `/c/${c}/schedule?view=week`, 'Week of'],
      ['Patients', `/c/${c}/patients`, 'Find a patient'],
      ['Requests', `/c/${c}/requests`, 'Prescription refill'],
      ['Calls', `/c/${c}/calls`, 'What the assistant did'],
      ['Team', `/c/${c}/team`, 'Add a person'],
      ['Settings', `/c/${c}/settings`, 'Greeting'],
      ['Knowledge', `/c/${c}/settings/knowledge`, 'Add a document'],
      ['Integrations', `/c/${c}/settings/integrations`, 'Add an endpoint'],
      ['Audit log', `/c/${c}/audit`, 'Rows can be added'],
      ['Test call', `/c/${c}/test-call`, 'Test call'],
    ];
    const problems: string[] = [];
    for (const [name, path, ready] of pages) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByText(ready).first()).toBeVisible();
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').analyze();
      for (const v of result.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
        problems.push(`${name}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      }
    }
    expect(problems).toEqual([]);
  });
}
