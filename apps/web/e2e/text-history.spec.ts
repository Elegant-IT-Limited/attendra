import { expect, type Page, test } from '@playwright/test';
import { signInAgain } from './session';

// Text history for the clinic (2026-11-16, demo findings 4, item 1), read-only, on the vet demo clinic's made-up texts:
// a pet's Texts tab, the clinic's texts (on the Texts page since texts polish TX3) and its Not sent filter, and a
// visit's texts in its panel, each checked against the server's records; and each fits a phone (390 px) with no
// sideways scroll.
type Text = { id: string; template: string; status: string; body: string | null; appointmentId: string | null; appointmentStartsAt: string | null; patientName: string | null };
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(`/api/v1${path}`);
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
// the row's pill; why one was not sent is in its details (texts polish TX3)
const STATUS: Record<string, RegExp> = { delivered: /^Delivered$/, sent: /^Sent$/, queued: /^Waiting$/, not_sent: /^Not sent$/, failed: /^Not sent$/, undelivered: /^Not sent$/ };
const WHY: Record<string, RegExp> = { not_sent: /^Not sent: /, failed: /^Not sent: the carrier refused it/, undelivered: /^Not sent: the carrier refused it/ };
const KIND: Record<string, string> = { booking_confirmed: 'Booking confirmed', request_ready: 'Refill ready to pick up', directions: 'Address and directions', reminder: 'Reminder before a visit', hours: 'Opening hours' };
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe.serial('text history', () => {
  let page: Page;
  let C: string;
  let biscuit: string;
  test.beforeAll(async ({ browser }) => {
    page = await signInAgain(browser, 'Vet clinic manager');
    C = clinicOf(page);
    const pets = await call<{ patients: { id: string; name: string }[] }>(page, `/clinics/${C}/patients`);
    biscuit = pets.patients.find((p) => p.name.startsWith('Biscuit'))!.id;
  });

  test('a pet\'s Texts tab shows the household\'s texts as the server has them, with the words that went out', async () => {
    const server = (await call<{ texts: Text[] }>(page, `/clinics/${C}/texts?patientId=${biscuit}`)).texts;
    expect(server.length).toBeGreaterThanOrEqual(3);
    await page.goto(`/c/${C}/patients/${biscuit}`);
    await page.getByRole('tab', { name: /^Texts/ }).click();
    const rows = page.getByTestId('text-row');
    await expect(rows).toHaveCount(server.length);
    for (const [i, t] of server.entries()) {
      const row = rows.nth(i);
      if (KIND[t.template]) await expect(row.getByTestId('text-kind')).toHaveText(KIND[t.template]!);
      await expect(row.getByTestId('text-status')).toHaveText(STATUS[t.status]!);
      await row.getByRole('button').first().click();
      if (WHY[t.status]) await expect(row.getByTestId('text-why')).toHaveText(WHY[t.status]!);
      if (t.body) await expect(row.getByTestId('text-body')).toHaveText(t.body);
      else await expect(row.getByTestId('text-body')).toHaveCount(0);
    }
  });

  test('the Texts page lists the clinic\'s texts, and the Not sent filter shows exactly those', async () => {
    const all = (await call<{ texts: Text[] }>(page, `/clinics/${C}/texts?recent=true&status=all`)).texts.slice(0, 10);
    const notSent = (await call<{ texts: Text[] }>(page, `/clinics/${C}/texts?recent=true&status=not_sent`)).texts;
    expect(notSent.length).toBeGreaterThan(0);
    await page.goto(`/c/${C}/texts`);
    await expect(page.getByTestId('text-row')).toHaveCount(all.length);
    await expect(page.getByTestId('text-row').first()).toHaveAttribute('data-text-id', all[0]!.id);
    // the pet each belongs to, and its request by number
    const withPet = all.find((t) => t.patientName)!;
    await expect(page.locator(`[data-text-id="${withPet.id}"]`).getByTestId('text-who')).toContainText(withPet.patientName!);
    await page.getByRole('button', { name: 'Not sent', exact: true }).click();
    await expect(page.getByTestId('text-row')).toHaveCount(Math.min(notSent.length, 10));
    for (const t of notSent.slice(0, 10)) await expect(page.locator(`[data-text-id="${t.id}"]`)).toHaveCount(1);
  });

  test('a visit\'s panel says where its texts are', async () => {
    const t = (await call<{ texts: Text[] }>(page, `/clinics/${C}/texts?patientId=${biscuit}`)).texts.find((x) => x.appointmentId && x.appointmentStartsAt)!;
    const visit = (await call<{ texts: Text[] }>(page, `/clinics/${C}/texts?appointmentId=${t.appointmentId}`)).texts;
    expect(visit.map((x) => x.id)).toContain(t.id);
    const settings = await call<{ timezone: string }>(page, `/clinics/${C}/settings`);
    const day = new Date(t.appointmentStartsAt!).toLocaleDateString('en-CA', { timeZone: settings.timezone });
    await page.goto(`/c/${C}/schedule?date=${day}&appointment=${t.appointmentId}`);
    const texts = page.getByTestId('visit-texts');
    await expect(texts).toContainText(KIND[t.template]!);
    await expect(texts).toContainText(t.status === 'delivered' ? 'Delivered' : 'Sent');
  });

  test('both lists fit a phone, with no sideways scroll', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/c/${C}/patients/${biscuit}`);
    await page.getByRole('tab', { name: /^Texts/ }).click();
    await expect(page.getByTestId('text-row').first()).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    await page.goto(`/c/${C}/texts`);
    await expect(page.getByTestId('text-row').first()).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
