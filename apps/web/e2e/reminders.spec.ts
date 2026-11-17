import { expect, type Page, test } from '@playwright/test';
import { testNow } from './clock';
import { signInAgain } from './session';

// Texts polish TX0 (2026-11-17): reminders never went out. On the demo vet clinic, with reminders on: a desk booking
// inside the hours before it gets its reminder at once (the worker runs right after the booking; the demo has no
// Twilio, so the row says why it was not sent, as the real messenger records it), and a visit booked 40 minutes ahead
// says on its panel why it gets none. Each checked against what the server has.
type Settings = Record<string, unknown> & { timezone: string; texting?: { reminders?: Record<string, unknown> } & Record<string, unknown> };
type Text = { id: string; template: string; status: string; failureReason: string | null; appointmentId: string | null };
type Detail = { reminder: { state: string; reason: string | null; final: boolean } | null };
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { origin: new URL(page.url()).origin } });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test.describe.serial('appointment reminders (TX0)', () => {
  let page: Page;
  let C: string;
  let tz: string;
  let original: Settings;
  let bella: string;
  const visits: string[] = [];
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  /** The first free start from `minutes` ahead, on the minute, squeezed in with Override: the demo day has visits of its own. */
  async function book(patientId: string, minutes: number, provider = 'prov_ruiz') {
    const first = Math.ceil((testNow() + minutes * 60_000) / 60_000) * 60_000;
    for (let step = 0; step < 12; step++) {
      const res = await page.request.post(`/api/v1/clinics/${C}/appointments`, { headers: { origin: new URL(page.url()).origin }, data: {
        patientId, providerId: provider, visitTypeId: 'vt_vaccines', startsAt: new Date(first + step * 5 * 60_000).toISOString(),
        idempotencyKey: `e2e-reminder-${Date.now()}-${step}`, override: true, overrideReason: 'reminder check',
      } });
      if (res.status() === 409) continue;
      expect(res.status(), await res.text()).toBe(201);
      const { appointmentId } = await res.json() as { appointmentId: string };
      visits.push(appointmentId);
      return { id: appointmentId, startsAt: new Date(first + step * 5 * 60_000) };
    }
    throw new Error('no free time to book');
  }

  test.beforeAll(async ({ browser }) => {
    page = await signInAgain(browser, 'Vet clinic manager');
    C = clinicOf(page);
    original = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    tz = original.timezone;
    // reminders on, a day before, and no quiet hours (equal times): the suite runs at any hour
    await call(page, 'PUT', `/clinics/${C}/settings`, { ...original, texting: { ...original.texting, reminders: { enabled: true, hoursBefore: 24, quietFrom: '00:00', quietTo: '00:00', askOnBooking: true } } });
    // a pet whose owner said yes to texts at the desk (made up, a 555-01xx number)
    const saved = await call<{ id: string }>(page, 'POST', `/clinics/${C}/patients`, { firstName: 'Bella', lastName: 'Carter', dob: '2020-06-01', phone: '(720) 555-0186', gender: 'female', guardianName: 'Dana Carter', species: 'dog', textsOk: true });
    bella = saved.id;
  });
  // the clinic as it was for the specs after this one: its reminders setting, and none of these visits left booked
  test.afterAll(async () => {
    for (const id of visits) await page.request.post(`/api/v1/clinics/${C}/appointments/${id}/cancel`, { headers: { origin: new URL(page.url()).origin }, data: { reason: 'booked_in_error' } });
    const now = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    await call(page, 'PUT', `/clinics/${C}/settings`, { ...now, texting: { ...now.texting, reminders: original.texting?.reminders ?? { enabled: false } } });
  });

  test('a desk booking inside the hours before the visit gets its reminder at once, and the visit shows it', async () => {
    const v = await book(bella, 3 * 60);
    // the worker runs right after the booking: no waiting for its 10 minutes
    await expect.poll(async () => (await call<{ texts: Text[] }>(page, 'GET', `/clinics/${C}/texts?appointmentId=${v.id}`)).texts.filter((t) => t.template === 'reminder').length, { timeout: 30_000 }).toBe(1);
    const [reminder] = (await call<{ texts: Text[] }>(page, 'GET', `/clinics/${C}/texts?appointmentId=${v.id}`)).texts.filter((t) => t.template === 'reminder');
    // the demo has no Twilio: the messenger records it as not sent, and why
    expect(reminder).toMatchObject({ status: 'not_sent', failureReason: 'texting_off' });
    const detail = await call<Detail>(page, 'GET', `/clinics/${C}/appointments/${v.id}`);
    expect(detail.reminder).toMatchObject({ state: 'not_sent' });
    await page.goto(`/c/${C}/schedule?view=day&date=${day(v.startsAt)}&appointment=${v.id}`);
    const panel = page.getByRole('dialog', { name: 'Bella Carter' });
    await expect(panel.getByTestId('visit-texts')).toContainText('Reminder before a visit');
    await expect(panel.getByTestId('visit-texts')).toContainText('Not sent');
    await expect(panel.getByTestId('visit-reminder')).toHaveText('No reminder: the text was not sent. Texts below says why.');
  });

  test('a visit booked 40 minutes ahead gets none, and its panel says why', async () => {
    const v = await book(bella, 40, 'prov_bell');
    const detail = await call<Detail>(page, 'GET', `/clinics/${C}/appointments/${v.id}`);
    expect(detail.reminder).toEqual({ state: 'skipped', reason: 'booked_late', final: true, dueAt: null });
    await page.goto(`/c/${C}/schedule?view=day&date=${day(v.startsAt)}&appointment=${v.id}`);
    const panel = page.getByRole('dialog', { name: 'Bella Carter' });
    await expect(panel.getByTestId('visit-reminder')).toHaveText(/^No reminder: booked (39|40|41) minutes before the visit\.$/);
    // the worker keeps the reason on the visit, and texted nothing
    expect((await call<{ texts: Text[] }>(page, 'GET', `/clinics/${C}/texts?appointmentId=${v.id}`)).texts.filter((t) => t.template === 'reminder')).toHaveLength(0);
  });
});
