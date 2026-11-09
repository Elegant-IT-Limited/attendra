import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

/**
 * Toolbars (2026-11-08): a hint or a count next to buttons and selects shares their vertical centre, on every
 * line a toolbar wraps to, at desktop, tablet and phone widths. The Schedule's view hint ("Every visit as a list,
 * in time order") and the Agenda's "0 visits" sat on the controls' bottom edge (items-end).
 */
const WIDTHS = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'tablet', width: 820, height: 1100 }, { name: 'phone', width: 390, height: 844 }] as const;

/** The pairs of a toolbar's visible children that share a line but not a vertical centre (more than 2 px apart). */
async function offCentre(page: Page, name: string): Promise<string[]> {
  const row = page.locator(`[data-toolbar="${name}"]`);
  await expect(row).toBeVisible();
  return row.evaluate((el) => {
    const boxes = [...el.children]
      .filter((k) => { const r = k.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(k).position !== 'absolute'; })
      .map((k) => { const r = k.getBoundingClientRect(); return { what: `${k.tagName.toLowerCase()}${k.id ? `#${k.id}` : ''} "${(k.textContent ?? '').trim().slice(0, 24)}"`, top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 }; });
    const out: string[] = [];
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
      const sameLine = a.top < b.bottom && b.top < a.bottom;
      if (sameLine && Math.abs(a.mid - b.mid) > 2) out.push(`${a.what} at ${a.mid.toFixed(1)} vs ${b.what} at ${b.mid.toFixed(1)}`);
    }));
    return out;
  });
}

for (const size of WIDTHS) {
  test(`toolbar hints and counts share the controls' vertical centre (${size.name})`, async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.setViewportSize({ width: size.width, height: size.height });
    const clinic = new URL(page.url()).pathname.split('/')[2];

    await page.goto(`/c/${clinic}/schedule`);
    for (const view of ['day', 'week', 'month', 'agenda'] as const) {
      await page.locator(`#schedule-tab-${view}`).click();
      await expect(page.locator(`#schedule-tab-${view}`)).toHaveAttribute('aria-selected', 'true');
      expect(await offCentre(page, 'schedule'), `Schedule ${view}`).toEqual([]);
      expect(await offCentre(page, 'schedule-filters'), `Schedule filters ${view}`).toEqual([]);
    }
    // the Agenda's own filters and its count ("0 visits"); a phone shows the plain list instead (md:hidden), with no filter row
    if (size.width >= 768) expect(await offCentre(page, 'agenda'), 'Agenda filters').toEqual([]);
    else await expect(page.locator('[data-toolbar="agenda"]')).toBeHidden();
    await page.locator('#schedule-show').selectOption('cancelled');
    expect(await offCentre(page, 'cancelled'), 'Cancelled history').toEqual([]);

    for (const [path, name] of [['calls', 'calls'], ['requests', 'requests'], ['patients', 'pets']] as const) {
      await page.goto(`/c/${clinic}/${path}`);
      expect(await offCentre(page, name), path).toEqual([]);
    }
    // Quality has no toolbar row of controls and hints; its page still loads at this width
    await page.goto(`/c/${clinic}/quality`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
}

/**
 * The Schedule toolbar keeps its shape (2026-11-09): row 1 is prev/Today/next, the date and the view buttons (with the
 * view's hint as a caption under them, and the Agenda's range last); row 2 is the filters, in a fixed order. Switching
 * views never moves a control, and a filter never jumps into row 1.
 */
const SCHEDULE_CONTROLS = {
  previous: '[data-toolbar="schedule"] button[aria-label^="Previous"]',
  today: '[data-toolbar="schedule"] button:has-text("Today")',
  next: '[data-toolbar="schedule"] button[aria-label^="Next"]',
  date: '#schedule-date',
  views: '[role="tablist"][aria-label="View"]',
  hint: '#schedule-view-hint',
  provider: '#schedule-provider',
  show: '#schedule-show',
} as const;

type ControlName = keyof typeof SCHEDULE_CONTROLS;
async function boxes(page: Page): Promise<Record<ControlName, { x: number; y: number }>> {
  const out = {} as Record<ControlName, { x: number; y: number }>;
  for (const [name, sel] of Object.entries(SCHEDULE_CONTROLS) as [ControlName, string][]) {
    const b = await page.locator(sel).first().boundingBox();
    expect(b, `${name} is on the page`).not.toBeNull();
    out[name] = { x: Math.round(b!.x), y: Math.round(b!.y) };
  }
  return out;
}

for (const size of WIDTHS) {
  test(`the Schedule toolbar keeps every control in place across the four views (${size.name})`, async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.setViewportSize({ width: size.width, height: size.height });
    const clinic = new URL(page.url()).pathname.split('/')[2];
    await page.goto(`/c/${clinic}/schedule`);
    await page.locator('#schedule-tab-day').click();
    await expect(page.locator('#schedule-tab-day')).toHaveAttribute('aria-selected', 'true');
    const day = await boxes(page);
    // the filters are below the first row, never in it: their top is under every row-1 control's bottom
    const row1Bottom = Math.max(...await Promise.all(['previous', 'date', 'views'].map(async (n) => {
      const b = await page.locator(SCHEDULE_CONTROLS[n as ControlName]).first().boundingBox(); return b!.y + b!.height;
    })));
    expect(day.provider.y, 'filters sit in row 2').toBeGreaterThanOrEqual(row1Bottom);
    expect(day.show.y, 'filters sit in row 2').toBeGreaterThanOrEqual(row1Bottom);
    // the hint is a caption under the view buttons, starting where they start
    expect(day.hint.x).toBe(day.views.x);
    expect(day.hint.y).toBeGreaterThan(day.views.y);
    for (const view of ['week', 'month', 'agenda'] as const) {
      await page.locator(`#schedule-tab-${view}`).click();
      await expect(page.locator(`#schedule-tab-${view}`)).toHaveAttribute('aria-selected', 'true');
      const now = await boxes(page);
      for (const name of Object.keys(SCHEDULE_CONTROLS) as ControlName[]) {
        expect(Math.abs(now[name].x - day[name].x), `${name} x in ${view} vs day`).toBeLessThanOrEqual(1);
        expect(Math.abs(now[name].y - day[name].y), `${name} y in ${view} vs day`).toBeLessThanOrEqual(1);
      }
    }
    // the Agenda's range buttons sit in row 1, after the view buttons
    const range = await page.locator('[role="group"][aria-label="Agenda range"]').boundingBox();
    expect(range).not.toBeNull();
    expect(range!.y).toBeLessThan(day.provider.y);
  });
}
