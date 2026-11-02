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
  await page.goto(`/c/${clinic}/schedule?view=day&date=${DAY}`);
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
