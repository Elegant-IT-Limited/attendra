import { expect, type Page, test } from '@playwright/test';
import { signInAgain } from './session';

// Text history for the clinic (2026-11-16, demo findings 4, item 1), read-only, on the vet demo clinic's made-up texts:
// a pet's Texts tab, Settings > Texting's Recent texts and its Not sent filter, and a visit's texts in its panel, each
// checked against the server's records; and each fits a phone (390 px) with no sideways scroll.
type Text = { id: string; template: string; status: string; body: string | null; appointmentId: string | null; appointmentStartsAt: string | null; patientName: string | null };
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(`/api/v1${path}`);
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
const STATUS: Record<string, RegExp> = { delivered: /^Delivered$/, sent: /^Sent$/, queued: /^Waiting$/, not_sent: /^Not sent: /, failed: /^Not sent: the carrier refused it/, undelivered: /^Not sent: the carrier refused it/ };
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
      if (t.body) {
        await row.getByText('The words that went out').click();
        await expect(row.getByTestId('text-body')).toHaveText(t.body);
      } else await expect(row.getByTestId('text-body')).toHaveCount(0);
    }
  });

  test('Settings > Texting lists the clinic\'s recent texts, and the Not sent filter shows exactly those', async () => {
    const all = (await call<{ texts: Text[] }>(page, `/clinics/${C}/texts?recent=true&status=all`)).texts;
    const notSent = (await call<{ texts: Text[] }>(page, `/clinics/${C}/texts?recent=true&status=not_sent`)).texts;
    expect(notSent.length).toBeGreaterThan(0);
    await page.goto(`/c/${C}/settings/texting`);
    const section = page.locator('#recent-texts');
    await expect(section.getByTestId('text-row')).toHaveCount(all.length);
    await expect(section.getByTestId('text-row').first()).toHaveAttribute('data-text-id', all[0]!.id);
    // the pet each belongs to
    const withPet = all.find((t) => t.patientName)!;
    await expect(section.locator(`[data-text-id="${withPet.id}"]`).getByTestId('text-pet')).toHaveText(withPet.patientName!);
    await section.getByRole('button', { name: 'Not sent' }).click();
    await expect(section.getByTestId('text-row')).toHaveCount(notSent.length);
    for (const t of notSent) await expect(section.locator(`[data-text-id="${t.id}"]`)).toHaveCount(1);
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
    await page.goto(`/c/${C}/settings/texting`);
    await expect(page.locator('#recent-texts').getByTestId('text-row').first()).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
