import { expect, type Page, test } from '@playwright/test';
import { signInAgain } from './session';

// Dashboard polish from a test clinic (2026-11-16), on the demo vet clinic with made-up data: one phone format on a
// pet (P1), the assignee picker shows whole names (U1), a vet clinic's owner asks to cancel (U2), and Reschedule never
// offers the visit's own time (U3). Shown values are checked against what the server sends.
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { origin: new URL(page.url()).origin } });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}
const digits = (s: string) => s.replace(/\D/g, '');

test.describe('dashboard polish, 2026-11-16', () => {
  let page: Page;
  let C: string;
  test.beforeAll(async ({ browser }) => {
    page = await signInAgain(browser, 'Vet clinic manager');
    C = clinicOf(page);
  });

  test('P1: a pet\'s Details write the phone as its header does', async () => {
    const pet = (await call<{ patients: { id: string; phone: string | null }[] }>(page, 'GET', `/clinics/${C}/patients`)).patients.find((p) => p.phone)!;
    await page.goto(`/c/${C}/patients/${pet.id}`);
    const header = page.getByRole('main').locator(`a[href^="tel:"]`).first();
    await expect(header).toBeVisible();
    await page.getByRole('tab', { name: 'Details' }).click();
    const field = page.getByLabel('Owner\'s phone');
    await expect(field).toHaveValue((await header.textContent())!.trim());
    expect(digits(await field.inputValue())).toBe(digits(pet.phone!).slice(-10));
    await expect(field).not.toHaveValue(/^\+/);
  });

  test('U1: after Claim, the assignee picker shows the whole name', async () => {
    const task = await call<{ id: string }>(page, 'POST', `/clinics/${C}/tasks`, { type: 'callback', reason: 'Asked about a nail trim' });
    await page.goto(`/c/${C}/requests?open=${task.id}`);
    const card = page.getByTestId('task');
    await card.getByRole('button', { name: 'Claim' }).click();
    await expect(card.getByText('You have it')).toBeVisible();
    const picker = card.getByLabel('Assign to');
    const me = (await call<{ user: { name: string } }>(page, 'GET', '/me')).user.name;
    await expect(picker.locator('option:checked')).toHaveText(`${me} (you), has it`);
    // the closed picker is at least as wide as the name it shows, with its arrow
    const fits = await picker.evaluate((el: HTMLSelectElement) => {
      const s = getComputedStyle(el);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const text = ctx.measureText(el.selectedOptions[0]!.text).width;
      return text + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) <= el.clientWidth + 1;
    });
    expect(fits).toBe(true);
  });

  test('U2 and U3: a vet clinic\'s owner asks to cancel, and Reschedule never offers the visit\'s own time', async () => {
    const settings = await call<{ timezone: string }>(page, 'GET', `/clinics/${C}/settings`);
    const today = new Date().toISOString().slice(0, 10);
    const list = await call<{ appointments: { id: string; patientId: string; startsAt: string; status: string; providerId: string; visitTypeId: string }[] }>(page, 'GET', `/clinics/${C}/appointments?from=${today}&days=14`);
    const a = list.appointments.filter((x) => x.status === 'booked' && Date.parse(x.startsAt) > Date.now() + 86_400_000).sort((x, y) => x.startsAt.localeCompare(y.startsAt))[0]!;
    const day = new Date(a.startsAt).toLocaleDateString('en-CA', { timeZone: settings.timezone });
    // the server, asked as the Reschedule picker asks (for this pet: only the vets who see its kind, K1): the visit's own
    // place is not a time to move it to
    const slots = (await call<{ slots: { providerId: string; startsAt: string }[] }>(page, 'GET', `/clinics/${C}/appointments/slots?visitTypeId=${a.visitTypeId}&from=${day}&days=1&excluding=${a.id}&patientId=${a.patientId}`)).slots;
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.filter((s) => s.providerId === a.providerId && Date.parse(s.startsAt) === Date.parse(a.startsAt))).toEqual([]);

    await page.goto(`/c/${C}/schedule?date=${day}&appointment=${a.id}`);
    const panel = page.getByRole('dialog').last();
    await panel.getByRole('button', { name: 'Reschedule' }).click();
    const times = panel.getByRole('radiogroup', { name: 'Open times' });
    await expect(times).toBeVisible();
    // the picker shows what the server offered for that time: the other vets, never the visit's own
    const own = (await call<{ providers: { id: string; name: string }[] }>(page, 'GET', `/clinics/${C}/settings`)).providers.find((p) => p.id === a.providerId)!;
    const sameTime = times.locator(`[data-starts-at="${new Date(a.startsAt).toISOString()}"]`);
    await expect(sameTime).toHaveCount(slots.filter((s) => Date.parse(s.startsAt) === Date.parse(a.startsAt)).length);
    await expect(sameTime.filter({ hasText: own.name })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Back' }).first().click();

    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    const reason = panel.getByLabel('Why is it cancelled?');
    await expect(reason.locator('option').first()).toHaveText('The owner asked');
    await expect(reason).toHaveValue('patient_asked');
  });
});
