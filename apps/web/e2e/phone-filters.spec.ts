import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

/**
 * Note 52 C14: at phone width (400 px) the Veterinarians filter read "Any animal or servic" and the search box did not
 * span the row; the Requests dates ran past the card. On every list page's filter row, at 400 px: each control stays
 * inside the card, a dropdown spans the row (so its words are whole), and so does the search box.
 */
async function check(page: Page, group: string) {
  const row = page.locator(`[data-filters="${group}"]`);
  await expect(row).toBeVisible();
  return row.evaluate((el) => {
    const out: string[] = [];
    const box = el.getBoundingClientRect();
    const name = (k: Element) => `${k.tagName.toLowerCase()}${k.id ? `#${k.id}` : ''}`;
    for (const k of el.querySelectorAll('select, input, button')) {
      const r = k.getBoundingClientRect();
      if (!r.width) continue;
      if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`${name(k)} runs past the card (${r.left.toFixed(0)}-${r.right.toFixed(0)} in ${box.left.toFixed(0)}-${box.right.toFixed(0)})`);
    }
    for (const k of el.querySelectorAll('select, input[type="search"]')) {
      const r = k.getBoundingClientRect();
      if (r.width && r.width < box.width - 1) out.push(`${name(k)} does not span the row (${r.width.toFixed(0)} of ${box.width.toFixed(0)})`);
    }
    // a placeholder wider than its box is cut
    for (const k of el.querySelectorAll<HTMLInputElement>('input[type="search"]')) {
      const s = getComputedStyle(k);
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const room = k.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      if (c.measureText(k.placeholder).width > room) out.push(`${name(k)}'s hint "${k.placeholder}" is cut`);
    }
    return out;
  });
}

test('every list page\'s filter row fits a 400 px phone: nothing cut, the dropdowns and search span the row', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.setViewportSize({ width: 400, height: 860 });
  for (const [path, group] of [['doctors', 'doctors'], ['requests', 'requests'], ['patients', 'pets']] as const) {
    await page.goto(`/c/${clinic}/${path}`);
    expect(await check(page, group), path).toEqual([]);
  }
  // the Pets search sits under its filter row, with its own label: its hint is whole too
  const search = page.locator('#patient-search');
  const fits = await search.evaluate((k: HTMLInputElement) => {
    const s = getComputedStyle(k);
    const c = document.createElement('canvas').getContext('2d')!;
    c.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    return c.measureText(k.placeholder).width <= k.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  });
  expect(fits, await search.getAttribute('placeholder') ?? '').toBe(true);
});
