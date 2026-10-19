import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

/** The names of the visit types, top to bottom, as the Settings page shows them now. */
const order = (page: Page) => page.locator('#visits [data-sortable-item]').evaluateAll((rows) => rows.map((r) => (r.querySelector('input') as HTMLInputElement | null)?.value ?? ''));

test('a card is dragged anywhere in its list, by the card itself, and the arrow keys move it too', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  // tall enough to see the whole list at once: the drag stays on screen
  await page.setViewportSize({ width: 1280, height: 2200 });
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings#visits`);
  const rows = page.locator('#visits [data-sortable-item]');
  await expect(rows).toHaveCount(3);
  const before = await order(page);

  // hold the last card by its empty left edge (not a field) and drop it above the first
  await page.locator('#visits').scrollIntoViewIfNeeded();
  const last = (await rows.last().boundingBox())!;
  const first = (await rows.first().boundingBox())!;
  await page.mouse.move(last.x + 24, last.y + last.height - 12);
  await page.mouse.down();
  await page.mouse.move(last.x + 24, last.y + last.height - 30, { steps: 4 }); // a few pixels: the drag starts
  await page.mouse.move(last.x + 24, first.y + 8, { steps: 25 });
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([before[2], before[0], before[1]]);

  // clicking into a field is still typing, never a drag
  await rows.first().locator('input').first().click();
  await expect.poll(() => order(page)).toEqual([before[2], before[0], before[1]]);

  // the keyboard: the handle and the down arrow, and the handle keeps the focus
  const handle = () => page.getByRole('button', { name: new RegExp(`^Move ${before[2]}:`) });
  await handle().focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => order(page)).toEqual([before[0], before[2], before[1]]);
  await expect(handle()).toBeFocused();
  // nothing was saved: leaving the page drops the change
});
