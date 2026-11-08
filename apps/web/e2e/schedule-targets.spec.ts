import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openAs } from './session';

/**
 * Every visit on the day grid is a target anyone can tap (WCAG 2.2, 2.5.8: 24 by 24 pixels, or room around it),
 * and nothing sits under anything: short visits back to back, a visit cancelled and booked again in its slot, and
 * two booked at once. A fixed day in one lane, the same whatever hour the suite runs, served instead of the demo's
 * own visits (which are seeded around now, so which of these shapes a run meets depended on the hour).
 */
const DAY = '2027-03-10'; // a Wednesday, when Dr. Okafor works; Denver is UTC-7 that day
const at = (time: string) => new Date(`${DAY}T${time}:00-07:00`).toISOString();
const visit = (id: string, name: string, from: string, to: string, status: 'booked' | 'cancelled' = 'booked') => ({
  id, patientId: `p_${id}`, patientName: name, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: at(from), endsAt: at(to), status,
  cancelReason: status === 'cancelled' ? 'patient_asked' : null, bookedBy: { kind: 'staff', name: 'Jordan (front desk)' },
  cancelledBy: status === 'cancelled' ? { kind: 'staff', name: 'Jordan (front desk)' } : null, createdAt: at('08:00'),
  overrideReason: null, confirmedAt: null, confirmedVia: null, reminderSentAt: null,
});
const VISITS = [
  visit('back_1', 'Ada Brooks', '09:00', '09:15'), visit('back_2', 'Ben Carter', '09:15', '09:30'),
  visit('was', 'Cleo Dunn', '10:00', '10:20', 'cancelled'), visit('now', 'Dev Ellis', '10:00', '10:20'),
  visit('both_1', 'Eve Fox', '11:00', '11:30'), visit('both_2', 'Finn Gale', '11:15', '11:45'),
];

test('every visit on the day grid can be tapped and opens its panel: short, rebooked and overlapping visits, light and dark', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2]!;
  await page.route((u) => u.pathname.endsWith(`/clinics/${clinic}/appointments`) && u.searchParams.has('from'),
    (route) => route.fulfill({ json: { from: new URL(route.request().url()).searchParams.get('from'), days: 1, appointments: VISITS } }));
  await page.route((u) => /\/appointments\/[a-z_0-9]+$/.test(u.pathname), (route) => {
    const v = VISITS.find((x) => new URL(route.request().url()).pathname.endsWith(`/appointments/${x.id}`));
    if (!v) return route.fallback();
    return route.fulfill({ json: { ...v, note: null, updatedAt: v.createdAt, patient: { id: v.patientId, name: v.patientName, dob: '1990-01-01', phone: '+13035550101' } } });
  });
  await page.goto(`/c/${clinic}/schedule?view=day&date=${DAY}&show=all`);
  await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  const blocks = page.getByTestId('lane').filter({ has: page.getByRole('button', { name: /Ada Brooks/ }) }).getByTestId('appointment');
  await expect(blocks).toHaveCount(VISITS.length);

  // at least 24 pixels each way, and no two blocks overlapping
  const boxes = await Promise.all((await blocks.all()).map(async (b) => ({ name: await b.getAttribute('aria-label'), box: (await b.boundingBox())! })));
  for (const { name, box } of boxes) {
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(24);
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(24);
  }
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const apart = a.box.x + a.box.width <= b.box.x + 0.5 || b.box.x + b.box.width <= a.box.x + 0.5 || a.box.y + a.box.height <= b.box.y + 0.5 || b.box.y + b.box.height <= a.box.y + 0.5;
      expect(apart, `${a.name} and ${b.name} overlap`).toBe(true);
    }
  }
  // the booked one first, the cancelled one beside it
  const rebooked = boxes.find((b) => b.name?.includes('Dev Ellis'))!.box;
  const cancelled = boxes.find((b) => b.name?.includes('Cleo Dunn'))!.box;
  expect(rebooked.x).toBeLessThan(cancelled.x);

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('attendra.theme', t), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(blocks).toHaveCount(VISITS.length);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity));
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').analyze();
    expect(result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  }
  await page.evaluate(() => localStorage.removeItem('attendra.theme'));

  // each block, clicked where a person would (its middle, not forced), opens its own panel
  for (const v of VISITS) {
    await page.getByTestId('appointment').and(page.getByRole('button', { name: new RegExp(v.patientName) })).click();
    const panel = page.getByRole('dialog', { name: v.patientName });
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`appointment=${v.id}`));
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
});

/**
 * The week view (note 13 follow-up): a lane there is 5rem, room for two visits side by side at 24 pixels or more. Three
 * at the same moment would each be narrower, so the first stays a block and the others gather into one "+2" target
 * that lists them, reached by the keyboard like any visit. The buffer after a visit (Settings, "Minutes kept free
 * after") is drawn as a lighter tail under it, named for a screen reader (SCH-8).
 */
const WEEK_VISITS = [
  visit('w1', 'Hana Iles', '10:00', '10:30'), visit('w2', 'Ivo Jensen', '10:00', '10:30'), visit('w3', 'Jade Kim', '10:00', '10:30'),
  visit('w4', 'Gus Hale', '11:00', '11:15'),
];

test('the week view: three visits at once are one block and "+2", every target 24 pixels, the list opens by mouse and keyboard; the buffer is drawn', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2]!;
  await page.route((u) => u.pathname.endsWith(`/clinics/${clinic}/appointments`) && u.searchParams.has('from'),
    (route) => route.fulfill({ json: { from: new URL(route.request().url()).searchParams.get('from'), days: 7, appointments: WEEK_VISITS } }));
  await page.route((u) => /\/appointments\/w\d$/.test(u.pathname), (route) => {
    const v = WEEK_VISITS.find((x) => new URL(route.request().url()).pathname.endsWith(`/appointments/${x.id}`))!;
    return route.fulfill({ json: { ...v, note: null, updatedAt: v.createdAt, patient: { id: v.patientId, name: v.patientName, dob: '1990-01-01', phone: '+13035550102' } } });
  });
  // the sick visit keeps 10 minutes free after it, for this page only
  await page.route((u) => u.pathname.endsWith(`/clinics/${clinic}/settings`), async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    return route.fulfill({ response: res, json: { ...body, visitTypes: body.visitTypes.map((v: { id: string }) => (v.id === 'vt_sick' ? { ...v, bufferMinutes: 10 } : v)) } });
  });
  await page.goto(`/c/${clinic}/schedule?view=week&date=${DAY}&show=all`);
  await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  const lane = page.getByTestId('lane').filter({ has: page.getByRole('button', { name: /Gus Hale/ }) });
  await expect(lane.getByTestId('appointment')).toHaveCount(2);
  const more = lane.getByTestId('more-visits');
  await expect(more).toHaveText('+2');
  await expect(more).toHaveAccessibleName('2 more visits from 10:00 AM: Ivo Jensen, Jade Kim');

  // every target at least 24 pixels each way, none on top of another
  const targets = [...(await lane.getByTestId('appointment').all()), more];
  const boxes = await Promise.all(targets.map(async (b) => ({ name: await b.getAttribute('aria-label'), box: (await b.boundingBox())! })));
  for (const { name, box } of boxes) {
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(24);
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(24);
  }
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const apart = a.box.x + a.box.width <= b.box.x + 0.5 || b.box.x + b.box.width <= a.box.x + 0.5 || a.box.y + a.box.height <= b.box.y + 0.5 || b.box.y + b.box.height <= a.box.y + 0.5;
      expect(apart, `${a.name} and ${b.name} overlap`).toBe(true);
    }
  }

  // the buffer: a tail right under each visit drawn as a block, as long as the minutes kept free, named
  const tail = lane.getByRole('img', { name: '10 minutes kept free after Gus Hale' });
  await expect(tail).toHaveCount(1);
  const gus = (await lane.getByRole('button', { name: /Gus Hale/ }).boundingBox())!;
  const t = (await tail.boundingBox())!;
  expect(Math.abs(t.y - (gus.y + gus.height))).toBeLessThan(3);
  expect(t.height).toBeGreaterThan(10);
  expect(t.height).toBeLessThan(10 * 1.75 + 2);
  await expect(lane.getByTestId('visit-buffer')).toHaveCount(2); // Hana Iles's too

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((th) => localStorage.setItem('attendra.theme', th), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(lane.getByTestId('more-visits')).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity));
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').analyze();
    expect(result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  }
  await page.evaluate(() => localStorage.removeItem('attendra.theme'));

  // the keyboard: to "+2", Enter opens the list with the first in it focused, Enter opens that visit's panel
  await lane.getByTestId('more-visits').focus();
  await page.keyboard.press('Enter');
  const list = page.getByTestId('more-visits-list');
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(list.getByRole('button').first()).toContainText('Ivo Jensen');
  await expect(list.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Ivo Jensen' })).toBeVisible();
  await expect(page).toHaveURL(/appointment=w2/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Ivo Jensen' })).toBeHidden();
  // and the mouse
  await lane.getByTestId('more-visits').click();
  await list.getByRole('button', { name: /Jade Kim/ }).click();
  await expect(page.getByRole('dialog', { name: 'Jade Kim' })).toBeVisible();
  await page.keyboard.press('Escape');
});
