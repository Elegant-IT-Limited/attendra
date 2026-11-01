import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { E2E_PROVISIONING_TOKEN } from './auth-state';
import { newContext, signInPatiently } from './session';

/*
 * The Schedule at a clinic of two hundred veterinarians (a group practice that imported its whole
 * roster). The other schedule specs use the demo clinic's handful of vets; this one opens an empty
 * clinic the way the hosting layer does, imports 200 made-up vets and books 300 visits over the next
 * seven days through the API, then checks that the Day view draws only the lanes in use with readable
 * headers, that the Vets picker pins lanes, that the Agenda lists the day and opens a visit, that
 * both render fast, and that axe finds nothing serious on either.
 */

const RUN = Date.now().toString(36);
const ZONE = 'America/Denver';
const OWNER = { name: 'Casey Marlow', email: `casey.${RUN}@bigpaws-demo.test`, password: 'big paws owner passphrase' };
const VETS = 200;
const VISITS = 300;
const PER_DAY = 60;
const VETS_PER_DAY = 20;
const PETS = 40;
const SPECIALTIES = ['Surgery', 'Dentistry', 'Dermatology', 'Cardiology', 'Exotic animals', 'Internal medicine'];
/** The starter clinic's visit types, by id and the name the doctor CSV uses. */
const TYPES = [['vt_wellness', 'wellness exam'], ['vt_sick', 'sick visit'], ['vt_vaccines', 'vaccine appointment'], ['vt_surgery_consult', 'surgery consultation']] as const;
const PET_NAMES = ['Biscuit', 'Mochi', 'Pepper', 'Clover', 'Waffle', 'Juniper', 'Olive', 'Pickle', 'Maple', 'Nutmeg'];

const vetName = (i: number) => `Dr. Vet ${String(i + 1).padStart(3, '0')}`;
const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(d);
/** A clinic-local date and time as an instant, without a time zone library: the wall clock read back in the zone gives the offset. */
function zoned(date: string, time: string) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(wall));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const asIf = Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00Z`);
  return new Date(wall - (asIf - wall)).toISOString();
}
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** The next seven days from tomorrow, clinic time, and the weekdays among them: every visit falls on a weekday, in the vets' hours. */
const DATES = Array.from({ length: 7 }, (_, i) => localDate(new Date(Date.now() + (i + 1) * 86_400_000)));
const WEEKDAYS = DATES.filter((d) => { const wd = new Date(`${d}T12:00:00Z`).getUTCDay(); return wd >= 1 && wd <= 5; });
/**
 * The 300 visits: 60 a weekday, twenty vets with three each at 9, 10 and 11, a different twenty each day
 * (vets 1 to 100 over the week; 101 to 200 have nothing booked), the visit types cycling, forty pets in turn.
 */
const VISIT_PLAN = Array.from({ length: VISITS }, (_, v) => {
  const day = Math.floor(v / PER_DAY);
  const slot = v % PER_DAY;
  return { date: WEEKDAYS[day]!, vet: day * VETS_PER_DAY + Math.floor(slot / 3), time: `${String(9 + (slot % 3)).padStart(2, '0')}:00`, type: TYPES[v % TYPES.length]!, pet: v % PETS };
});
const DAY = WEEKDAYS[0]!;
const onDay = VISIT_PLAN.filter((x) => x.date === DAY);

/** Where the first test leaves the clinic: its id and the owner's signed-in browser state, for the tests after it. */
let clinicId = '';
let state: Awaited<ReturnType<ReturnType<Page['context']>['storageState']>> | undefined;

/** A page signed in as the owner, watching for the first lane or agenda row so a test can read when it appeared. */
async function openPage(browser: Browser) {
  const context = await newContext(browser, { storageState: state });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __firstGrid?: number };
    const look = () => {
      if (w.__firstGrid === undefined && document.querySelector('[data-testid=lane], [data-testid=agenda-row]')) w.__firstGrid = performance.now();
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
  return page;
}
/** Milliseconds from the navigation to the first lane or agenda row, as the page itself measured it. */
const firstGridAt = (page: Page) => page.evaluate(() => (window as unknown as { __firstGrid?: number }).__firstGrid ?? null);

async function noSeriousAxe(page: Page, where: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').analyze();
  const problems = result.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((v) => `${where}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(problems).toEqual([]);
}

test.describe.serial('the schedule of a clinic with 200 veterinarians', () => {
  test('is set up: an empty clinic, 200 vets imported, 40 pets, 300 visits over the next week', async ({ browser, request }) => {
    test.setTimeout(300_000);
    const headers = { authorization: `Bearer ${E2E_PROVISIONING_TOKEN}` };
    const opened = await request.post('/api/v1/provisioning/accounts', { headers, data: {
      organization: { name: 'Big Paws Veterinary Group' }, clinic: { name: 'Big Paws Veterinary Group', timezone: ZONE, industry: 'vet', phone: '+17205550170' }, owner: OWNER,
    } });
    expect(opened.status(), await opened.text()).toBe(201);
    clinicId = ((await opened.json()) as { clinicId: string }).clinicId;
    expect((await request.post('/api/v1/provisioning/email-confirmations', { headers, data: { email: OWNER.email } })).status()).toBe(204);

    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await signInPatiently(page, () => page.getByRole('button', { name: 'Sign in', exact: true }).click());
    await expect(page).toHaveURL(new RegExp(`/c/${clinicId}$`), { timeout: 30_000 });
    const api = page.request; // the owner's cookies, through the dashboard's own /api
    const origin = { origin: 'http://localhost:3000' }; // a write from anywhere else is turned away

    // the roster, as a clinic imports it: six specialties in turn, Monday to Friday 8 to 5, the last vet away all week
    const hours = Array(5).fill('08:00-17:00');
    const csv = [
      ['id', 'name', 'gender', 'phone', 'specialty', 'categories', 'ages_min', 'ages_max', 'accepting_new_patients', 'visit_types', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'time_off'],
      // every vet needs a number of their own at a vet clinic (2026-11-01): two hundred made-up ones, in two area codes
      ...Array.from({ length: VETS }, (_, i) => ['', vetName(i), i % 2 ? 'male' : 'female', `(${i < 100 ? '720' : '303'}) 555-01${String(i % 100).padStart(2, '0')}`, SPECIALTIES[i % SPECIALTIES.length]!, '', '', '', 'yes', TYPES.map(([, name]) => name).join('; '), ...hours, '', '', i === VETS - 1 ? `${DATES[0]} to ${DATES[6]}` : '']),
    ].map((row) => row.map(csvCell).join(',')).join('\n');
    const imported = await api.post(`/api/v1/clinics/${clinicId}/doctors/import`, { headers: origin, data: { csv, dryRun: false } });
    expect(imported.status(), await imported.text()).toBe(200);
    const report = (await imported.json()) as { counts: { add: number; error: number } };
    expect(report.counts).toMatchObject({ add: VETS, error: 0 });
    const doctors = (await (await api.get(`/api/v1/clinics/${clinicId}/doctors`)).json()) as { providers: { id: string; name: string }[] };
    const vetIds = new Map(doctors.providers.map((p) => [p.name, p.id]));
    expect(vetIds.size).toBe(VETS);

    // forty pets, on forty made-up numbers
    const petIds: string[] = [];
    for (let i = 0; i < PETS; i++) {
      const res = await api.post(`/api/v1/clinics/${clinicId}/patients`, { headers: origin, data: {
        firstName: `${PET_NAMES[i % PET_NAMES.length]} ${Math.floor(i / PET_NAMES.length) + 1}`, lastName: 'Household', dob: '2021-03-04', gender: i % 2 ? 'male' : 'female',
        phone: `(720) 555-01${String(i).padStart(2, '0')}`, guardianName: `Owner ${i + 1}`, species: i % 3 ? 'dog' : 'cat',
      } });
      expect(res.status(), await res.text()).toBe(201);
      petIds.push(((await res.json()) as { id: string }).id);
    }

    // the visits, one booking each, so they pass the same rules as a booking from the front desk
    for (const [v, x] of VISIT_PLAN.entries()) {
      const res = await api.post(`/api/v1/clinics/${clinicId}/appointments`, { headers: origin, data: {
        patientId: petIds[x.pet], providerId: vetIds.get(vetName(x.vet)), visitTypeId: x.type[0], startsAt: zoned(x.date, x.time), idempotencyKey: `scale-${RUN}-${v}`,
      } });
      expect(res.status(), `visit ${v}: ${await res.text()}`).toBe(201);
    }
    state = await context.storageState();
  });

  test('opens on the Agenda: the day in time order, narrowed by vet, specialty and visit type, a row opens the visit', async ({ browser }) => {
    const page = await openPage(browser);
    await page.goto(`/c/${clinicId}/schedule?date=${DAY}`);
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
    const rows = page.getByTestId('agenda-row');
    const list = page.getByTestId('agenda-list');
    /** The list is as tall as every row, though only the rows in view are drawn. */
    const lists = (n: number) => expect(list).toHaveCSS('height', `${n * 44}px`);
    await lists(onDay.length);
    expect(await rows.count()).toBeLessThan(onDay.length);
    await expect(page.getByText(`${onDay.length} visits`)).toBeVisible();
    for (const i of [0, 1, 2]) await expect(rows.nth(i)).toContainText('9:00 AM');
    await expect(rows.first()).toContainText('Booked');
    await list.locator('..').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(rows.last()).toContainText('11:00 AM');
    await list.locator('..').evaluate((el) => { el.scrollTop = 0; });

    // narrowed by vet (the list's combobox), then specialty, then visit type, each from the clinic's own lists
    const vet = page.getByRole('combobox', { name: 'Veterinarian' });
    await vet.click();
    await vet.fill('Vet 001');
    await page.getByRole('listbox', { name: 'Choices for veterinarian' }).getByRole('option', { name: vetName(0), exact: true }).click();
    await expect(rows).toHaveCount(onDay.filter((x) => x.vet === 0).length);
    for (let i = 0; i < 3; i++) await expect(rows.nth(i)).toContainText(vetName(0));
    await vet.click();
    await page.getByRole('listbox', { name: 'Choices for veterinarian' }).getByRole('option', { name: 'None', exact: true }).click();
    await page.getByLabel('Specialty', { exact: true }).selectOption({ label: 'Surgery' });
    await expect(rows).toHaveCount(onDay.filter((x) => x.vet % SPECIALTIES.length === 0).length);
    await page.getByLabel('Visit type').selectOption({ label: 'wellness exam' });
    await expect(rows).toHaveCount(onDay.filter((x) => x.vet % SPECIALTIES.length === 0 && x.type[0] === 'vt_wellness').length);
    await page.getByLabel('Specialty', { exact: true }).selectOption({ index: 0 });
    await page.getByLabel('Visit type').selectOption({ index: 0 });
    await lists(onDay.length);

    // a row opens the same panel as a block on the grid
    const label = (await rows.first().getAttribute('aria-label'))!;
    await rows.first().click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    await expect(panel.getByText(label.split(', ')[1]!, { exact: true }).first()).toBeVisible();
    await expect(page).toHaveURL(/appointment=/);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await noSeriousAxe(page, 'Agenda, a day');

    // the week: a heading per weekday, and only the rows in view drawn of the three hundred
    await page.getByRole('button', { name: 'This week' }).click();
    await expect(page.getByRole('heading', { level: 2, name: /^Week of / })).toBeVisible();
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByText(`${VISITS} visits`)).toBeVisible();
    await lists(VISITS + WEEKDAYS.length);
    expect(await rows.count()).toBeLessThan(VISITS / 2);
    await list.locator('..').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(rows.last()).toContainText('11:00 AM');
  });

  test('the Day view draws the twenty lanes in use, every header readable, the hours column staying put while the grid scrolls', async ({ browser }) => {
    const page = await openPage(browser);
    await page.goto(`/c/${clinicId}/schedule?view=day&date=${DAY}`);
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    const heads = page.getByTestId('lane-head');
    await expect(heads).toHaveCount(VETS_PER_DAY);
    await expect(page.getByTestId('appointment')).toHaveCount(onDay.length);
    // twenty lanes are more than the card is wide, so each sits at its minimum: initials and the surname, the full name on hover
    await expect(heads.first()).toHaveAttribute('title', vetName(0));
    await expect(heads.first().getByText('V0', { exact: true })).toBeVisible();
    await expect(heads.first().getByText('001', { exact: true })).toBeVisible();
    await expect(heads.first().getByText(vetName(0), { exact: true })).toBeHidden();

    // every header at least 100 pixels wide, none on top of its neighbour
    const boxes = (await Promise.all((await heads.all()).map((h) => h.boundingBox())));
    const seen = boxes.map((b) => b!).sort((a, b) => a.x - b.x);
    for (const b of seen) expect(b.width).toBeGreaterThanOrEqual(100);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.x).toBeGreaterThanOrEqual(seen[i - 1]!.x + seen[i - 1]!.width - 1);

    // wider than the card: it scrolls sideways, and the hour labels stay at the left edge
    const scroller = page.getByTestId('schedule').locator('.overflow-x-auto').first();
    const hour = page.getByText('9 AM', { exact: true });
    const before = (await hour.boundingBox())!;
    await scroller.evaluate((el) => { el.scrollLeft = 600; });
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(600);
    const after = (await hour.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    const lastHead = (await heads.last().boundingBox())!;
    expect(lastHead.x).toBeLessThan(seen.at(-1)!.x); // the lanes moved
    await noSeriousAxe(page, 'Schedule, a day of 200 vets');
  });

  test('the Vets picker pins lanes: up to eight, says so at the ninth, narrowed by name, specialty and working today, remembered after a reload', async ({ browser }) => {
    const page = await openPage(browser);
    await page.goto(`/c/${clinicId}/schedule?view=day&date=${DAY}`);
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    const heads = page.getByTestId('lane-head');
    await expect(heads).toHaveCount(VETS_PER_DAY);
    await page.getByRole('button', { name: /^Vets: choose/ }).click();
    const picker = page.getByTestId('vets-picker');
    await expect(picker).toBeVisible();
    const list = picker.getByRole('list', { name: 'Veterinarians to show' });

    // by name: one vet with nothing booked gets a lane of their own
    await picker.getByLabel('Find a veterinarian').fill('Vet 150');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await picker.getByRole('checkbox', { name: vetName(149) }).click();
    await expect(heads).toHaveCount(VETS_PER_DAY + 1);
    await expect(heads.last()).toHaveAttribute('title', vetName(149));
    await expect(picker.getByText('1 of 8 chosen')).toBeVisible();

    // by specialty, from the clinic's list, and working today: the vet away all week drops out
    await picker.getByLabel('Find a veterinarian').fill('');
    const awaySpecialty = SPECIALTIES[(VETS - 1) % SPECIALTIES.length]!; // the vet away all week's own
    const inIt = Array.from({ length: VETS }, (_, i) => i).filter((i) => SPECIALTIES[i % SPECIALTIES.length] === awaySpecialty);
    await picker.getByLabel('Specialty').selectOption({ label: awaySpecialty });
    await expect(list.getByRole('listitem')).toHaveCount(inIt.length);
    await expect(list.getByRole('listitem').filter({ hasText: vetName(VETS - 1) })).toContainText('Not working today');
    await picker.getByRole('checkbox', { name: 'Working today' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(inIt.length - 1);
    await expect(list.getByRole('listitem').filter({ hasText: vetName(VETS - 1) })).toHaveCount(0);
    await picker.getByRole('checkbox', { name: 'Working today' }).click();
    await picker.getByLabel('Specialty').selectOption({ index: 0 });

    // seven more, to eight; the ninth is refused with a word, not silently
    for (let i = 100; i < 107; i++) await picker.getByRole('checkbox', { name: vetName(i) }).click();
    await expect(picker.getByText('8 of 8 chosen')).toBeVisible();
    await expect(heads).toHaveCount(VETS_PER_DAY + 8);
    await picker.getByRole('checkbox', { name: vetName(107) }).click();
    await expect(picker.getByRole('alert')).toHaveText('That is 8 already. Untick one to add another.');
    await expect(picker.getByRole('checkbox', { name: vetName(107) })).not.toBeChecked();
    await expect(heads).toHaveCount(VETS_PER_DAY + 8);
    await noSeriousAxe(page, 'the Vets picker');
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();

    // kept in this browser for this clinic, and the dropdown still narrows the grid to one
    expect(JSON.parse(await page.evaluate((id) => localStorage.getItem(`attendra.schedule.vets.${id}`) ?? '[]', clinicId))).toHaveLength(8);
    await page.reload();
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(heads).toHaveCount(VETS_PER_DAY + 8);
    await page.getByLabel('Provider').selectOption({ label: `${vetName(1)}, ${SPECIALTIES[1]}` });
    await expect(heads).toHaveCount(1);
    await expect(page.getByTestId('appointment')).toHaveCount(3);
    await page.getByLabel('Provider').selectOption({ index: 0 });
    await page.getByRole('button', { name: /^Vets: choose/ }).click();
    await page.getByTestId('vets-picker').getByRole('button', { name: 'Clear' }).click();
    await expect(heads).toHaveCount(VETS_PER_DAY);
    expect(await page.evaluate((id) => localStorage.getItem(`attendra.schedule.vets.${id}`), clinicId)).toBeNull();
  });

  test('the Day view and the Agenda each show their first row within a second of the navigation', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await openPage(browser);
    // once, so the dev server has compiled the page and the browser has its scripts: what a second visit costs
    await page.goto(`/c/${clinicId}/schedule?view=day&date=${DAY}`);
    await expect(page.getByTestId('lane').first()).toBeVisible({ timeout: 30_000 });
    const timings: Record<string, number> = {};
    for (const [name, url, row] of [['Day', `/c/${clinicId}/schedule?view=day&date=${DAY}`, 'lane'], ['Agenda', `/c/${clinicId}/schedule?view=agenda&date=${DAY}`, 'agenda-row']] as const) {
      // the median of three loads, so one slow tick of the dev server does not decide it
      const loads: number[] = [];
      for (let i = 0; i < 3; i++) {
        await page.goto(url);
        await expect(page.getByTestId(row).first()).toBeVisible({ timeout: 30_000 });
        const at = await firstGridAt(page);
        expect(at, `${name}: the first row was seen`).not.toBeNull();
        loads.push(at!);
      }
      timings[name] = loads.sort((a, b) => a - b)[1]!;
    }
    // and a switch between the two, which is the page re-rendering with the data it already has
    await page.goto(`/c/${clinicId}/schedule?view=agenda&date=${DAY}`);
    await expect(page.getByTestId('agenda-row').first()).toBeVisible();
    const t0 = await page.evaluate(() => performance.now());
    await page.getByRole('tab', { name: 'Day' }).click();
    await expect(page.getByTestId('lane').first()).toBeVisible();
    timings['Agenda to Day'] = (await page.evaluate(() => performance.now())) - t0;
    test.info().annotations.push({ type: 'render', description: Object.entries(timings).map(([k, v]) => `${k}: ${Math.round(v)} ms`).join(', ') });
    for (const [name, ms] of Object.entries(timings)) expect(ms, `${name} render: ${Math.round(ms)} ms`).toBeLessThan(1000);
  });
});
