import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type Browser, expect, type Locator, type Page, test } from '@playwright/test';
import { E2E_PROVISIONING_TOKEN } from './auth-state';
import { png } from './png';
import { newContext, signInPatiently } from './session';

/*
 * A brand-new owner's first day, through the screens only. The other specs start from the demo's
 * ready-made clinics; this one starts from an empty clinic opened the way the hosting layer opens one
 * (provisioning: a clinic, its owner, and the stand-in vet), and does what a person would.
 *
 * On every page it visits it runs axe, and it fails on any console error, any 4xx or 5xx the step did
 * not expect (each step lists the ones it does), and any problem dialog ("Not saved", "That did not
 * work") the step did not expect. A failure here is a bug in a screen: fix the screen, not the spec.
 */

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

const ORIGIN = 'http://localhost:3000';
/** Every run its own addresses, so a second run against the same servers starts empty too. */
const RUN = Date.now().toString(36);
const OWNER = { name: 'Avery Lindqvist', email: `avery.${RUN}@willowbend-demo.test`, password: 'willow bend owner passphrase' };
/** Someone with a login of their own already (another clinic's owner), invited to this one. */
const OTHER = { name: 'Morgan Ashdown', email: `morgan.${RUN}@stonebridge-demo.test`, password: 'stone bridge owner passphrase' };
/** Someone new, invited by email. */
const NEWCOMER = { name: 'Riley Okonkwo', email: `riley.${RUN}@willowbend-demo.test` };

/**
 * The clinic's time zone: one of these where it is daytime now, so a visit can be booked for today and Today
 * has something to show whatever hour the suite runs. Each with a number from there.
 */
const ZONES = [
  ['America/Denver', '+17205550161'], ['America/New_York', '+12125550161'], ['America/Chicago', '+13125550161'], ['America/Los_Angeles', '+14155550161'],
  ['Pacific/Honolulu', '+18085550161'], ['Pacific/Guam', '+16715550161'], ['Europe/London', '+442079460161'],
] as const;
const hourIn = (zone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const [ZONE, PHONE] = ZONES.find(([zone]) => hourIn(zone) >= 8 && hourIn(zone) < 15) ?? ZONES[0];

/** A response the step expects to be an error: its status, a pattern for its path, and on whose page (anyone's when left out). */
interface Expected { method?: string; path: RegExp; status: number; who?: string }

/**
 * What went wrong on the pages of the journey, gathered as it happens and checked at the end of each step,
 * against what that step expects.
 */
class Watch {
  private problems: string[] = [];
  private responses: Expected[] = [];
  private dialogs: RegExp[] = [];

  /** Starts watching a page: before its first load, so the dialog watcher is in from the start. */
  async page(page: Page, who: string) {
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // an error response is logged by the browser too: the response check below judges it
      if (/^Failed to load resource: the server responded with a status of \d{3}/.test(m.text())) return;
      this.problems.push(`${who}: console error: ${m.text().slice(0, 400)}`);
    });
    page.on('pageerror', (e) => this.problems.push(`${who}: page error: ${e.message.slice(0, 400)}`));
    page.on('response', (r) => {
      const url = new URL(r.url());
      if (url.origin !== ORIGIN || r.status() < 400) return;
      const method = r.request().method();
      // the sign-in page asks who is signed in, and nobody is yet
      if (new URL(page.url()).pathname === '/sign-in' && url.pathname === '/api/v1/me' && r.status() === 401) return;
      if (this.responses.some((e) => e.status === r.status() && e.path.test(url.pathname) && (!e.method || e.method === method) && (!e.who || e.who === who))) return;
      this.problems.push(`${who}: ${method} ${url.pathname} answered ${r.status()}`);
    });
    // a problem dialog is a dialog with an alert in it (components/ui/toast.tsx); its title is what it says
    await page.exposeBinding('__problemDialog', (_source, title: string) => {
      if (!this.dialogs.some((d) => d.test(title))) this.problems.push(`${who}: a dialog said "${title}"`);
    });
    await page.addInitScript(() => {
      const seen = new WeakSet<Element>();
      const look = () => {
        for (const dialog of document.querySelectorAll('[role=dialog]')) {
          if (seen.has(dialog) || !dialog.querySelector('[role=alert]')) continue;
          seen.add(dialog);
          const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent ?? dialog.textContent ?? '';
          (window as unknown as { __problemDialog: (t: string) => void }).__problemDialog(title.trim().slice(0, 200));
        }
      };
      new MutationObserver(look).observe(document, { childList: true, subtree: true });
    });
  }

  /** axe on the page as it is now: no serious or critical issue. */
  async axe(page: Page, where: string) {
    // a panel sliding in is half transparent: judged once it has arrived (endless ones, like a pulse, never end)
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity));
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('nextjs-portal').analyze();
    for (const v of result.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
      this.problems.push(`axe on ${where}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    }
  }

  /** One numbered step: what it expects to go wrong, then nothing else may. */
  async step(title: string, expects: { responses?: Expected[]; dialogs?: RegExp[] }, body: () => Promise<void>) {
    await test.step(title, async () => {
      this.responses = expects.responses ?? [];
      this.dialogs = expects.dialogs ?? [];
      this.problems = [];
      await body();
      // anything still on its way (a save, a refetch) is judged with this step
      await new Promise((r) => setTimeout(r, 300));
      expect(this.problems, `${title}: what went wrong`).toEqual([]);
    });
  }
}

/** The hosting layer's side, with this suite's own provisioning token. */
function provisioning(request: APIRequestContext) {
  const headers = { authorization: `Bearer ${E2E_PROVISIONING_TOKEN}` };
  return {
    async openAccount(clinic: string, owner: { name: string; email: string; password: string }, phone: string) {
      const res = await request.post('/api/v1/provisioning/accounts', { headers, data: {
        organization: { name: clinic }, clinic: { name: clinic, timezone: ZONE, industry: 'vet', phone }, owner,
      } });
      expect(res.status(), await res.text()).toBe(201);
      const opened = await res.json() as { organizationId: string; clinicId: string; userId: string };
      expect((await request.post('/api/v1/provisioning/email-confirmations', { headers, data: { email: owner.email } })).status()).toBe(204);
      return opened;
    },
    async openForOwner(userId: string, clinic: string, phone: string) {
      const res = await request.post('/api/v1/provisioning/accounts/for-user', { headers, data: {
        userId, organization: { name: clinic }, clinic: { name: clinic, timezone: ZONE, industry: 'vet', phone },
      } });
      expect(res.status(), await res.text()).toBe(201);
      return await res.json() as { organizationId: string; clinicId: string };
    },
    /** A hosted plan whose account pages are on this address, under /account, as the hosting layer's are. */
    async plan(clinicId: string) {
      const res = await request.put(`/api/v1/provisioning/clinics/${clinicId}/plan`, { headers, data: { plan: {
        status: 'active', includedMinutes: 300, periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 29 * 86_400_000).toISOString(), trialEndsAt: null, endsAt: null,
        manageUrl: `/account/billing?clinic=${clinicId}`, addLocationUrl: `/account/locations?clinic=${clinicId}`, newClinicUrl: '/account/new-clinic',
      } } });
      expect(res.status(), await res.text()).toBe(204);
    },
  };
}

/** Signs in through the sign-in page, in a browser of its own, watched from the first load. */
async function signIn(browser: Browser, watch: Watch, who: string, email: string, password: string) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await watch.page(page, who);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await signInPatiently(page, () => page.getByRole('button', { name: 'Sign in', exact: true }).click());
  return page;
}

/** A page of the clinic's menu, by its name. */
async function open(page: Page, name: string | RegExp) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: typeof name === 'string' }).first().click();
}

/** Picks a value from a list Combobox, by its label and the option's name. */
async function pick(scope: Locator, label: string, option: string) {
  const box = scope.getByRole('combobox', { name: label });
  await box.click();
  await scope.page().getByRole('listbox', { name: `Choices for ${label.toLowerCase()}` }).getByRole('option', { name: option, exact: true }).click();
  await expect(box).toHaveValue(option);
}

// ---------------------------------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------------------------------

// a click that cannot happen fails in seconds, not at the end of the journey's ten minutes
test.use({ actionTimeout: 20_000 });

test('first day: a new owner sets up an empty clinic, through the screens only', async ({ browser, request }) => {
  test.setTimeout(600_000);
  const watch = new Watch();
  const hosting = provisioning(request);
  const first = await hosting.openAccount('Willow Bend Animal Clinic', OWNER, PHONE);
  await hosting.plan(first.clinicId);

  const page = await signIn(browser, watch, 'owner', OWNER.email, OWNER.password);
  await expect(page).toHaveURL(new RegExp(`/c/${first.clinicId}$`), { timeout: 30_000 });
  const home = `/c/${first.clinicId}`;

  await watch.step('1. Profile: a name and a picture', {}, async () => {
    await page.getByRole('button', { name: /account and theme/ }).click();
    await page.getByRole('menuitem', { name: 'Your profile' }).click();
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible({ timeout: 20_000 });
    await watch.axe(page, 'Your profile');
    await page.getByLabel('Your name').fill('Avery Lindqvist-Hale');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.locator('#picture-file').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: png() });
    await expect(page.locator('img[data-avatar="picture"]')).toBeVisible();
    await page.goto(home);
    const account = page.getByRole('button', { name: 'Avery Lindqvist-Hale, Owner: account and theme' });
    await expect(account.locator('img[data-avatar="picture"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await watch.axe(page, 'Today, empty');
  });

  await watch.step('2. Settings: address, hours, the assistant, Spanish, fields and lists', {}, async () => {
    await open(page, 'Settings');
    await expect(page.getByLabel('Clinic name')).toHaveValue('Willow Bend Animal Clinic');
    await watch.axe(page, 'Settings');
    await page.getByLabel('Address').fill('18 Orchard Lane, Boulder');
    // every day, 8 to 6: weekends too
    const hours = page.locator('#hours');
    for (const day of ['Saturday', 'Sunday']) {
      await hours.locator('div.flex-wrap', { has: page.getByText(day, { exact: true }) }).first().getByRole('button', { name: 'Open this day' }).click();
    }
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      await page.getByLabel(`${day} opens`).fill('08:00');
      await page.getByLabel(`${day} closes`).fill('18:00');
    }
    await page.getByLabel('Assistant name').fill('Juniper');
    await page.getByRole('button', { name: 'Use the suggested greeting' }).first().click();
    await expect(page.getByLabel('Greeting')).toHaveValue(/I'm Juniper/);
    await page.getByLabel(/^Spanish/).check();
    const spanish = page.getByTestId('greeting-preview-es').getByRole('textbox');
    await expect(spanish).toHaveValue(/Juniper/);
    await spanish.fill('Gracias por llamar a Willow Bend. Soy Juniper, la asistente virtual de la clínica. ¿En qué le puedo ayudar?');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. The next call uses these settings.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Address')).toHaveValue('18 Orchard Lane, Boulder');
    await expect(page.getByLabel('Sunday closes')).toHaveValue('18:00');
    await expect(page.getByLabel('Assistant name')).toHaveValue('Juniper');
    await expect(page.getByTestId('greeting-preview-es').getByRole('textbox')).toHaveValue(/Soy Juniper, la asistente virtual de la clínica/);

    // Fields and lists: specialties, and a field on each vet
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Fields and lists' }).click();
    await page.getByRole('tab', { name: 'Veterinarians' }).click();
    await watch.axe(page, 'Fields and lists, Veterinarians');
    for (const s of ['Surgery', 'Dentistry']) {
      await page.getByLabel('Add to Specialty').fill(s);
      await page.getByLabel('Add to Specialty').press('Enter');
    }
    await page.getByRole('button', { name: 'Save specialty' }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    await page.getByRole('button', { name: 'Field', exact: true }).first().click();
    await page.getByPlaceholder('e.g. Qualifications').fill('Licence number');
    await page.getByRole('button', { name: 'Save fields' }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    await page.reload();
    await expect(page.getByPlaceholder('e.g. Qualifications')).toHaveValue('Licence number');
  });

  await watch.step('3. Vets: two added, one specialty picked and one added from the panel, one edited; the filter and the stand-in', {}, async () => {
    await open(page, 'Veterinarians');
    await expect(page.getByRole('heading', { name: 'Veterinarians' })).toBeVisible();
    // a new clinic starts with the stand-in, until a real vet is listed
    await expect(page.getByTestId('doctor')).toHaveCount(1);
    await expect(page.getByTestId('doctor')).toContainText(/our veterinarian/i);
    await watch.axe(page, 'Veterinarians, the stand-in only');

    await page.getByRole('button', { name: 'Add veterinarian' }).click();
    let panel = page.getByRole('dialog', { name: 'Add veterinarian' });
    await panel.getByLabel('Name').fill('Dr. Elena Marsh');
    await panel.getByLabel('Gender').selectOption({ label: 'Female' });
    await pick(panel, 'Specialty', 'Surgery');
    await panel.getByLabel('Licence number').fill('CO-VET-0161');
    await watch.axe(page, 'Add veterinarian');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('doctor').filter({ hasText: 'Dr. Elena Marsh' })).toContainText('Surgery');
    // the stand-in steps aside once a real vet is listed
    await expect(page.getByTestId('doctor')).toHaveCount(1);

    await page.getByRole('button', { name: 'Add veterinarian' }).click();
    panel = page.getByRole('dialog', { name: 'Add veterinarian' });
    await panel.getByLabel('Name').fill('Dr. Owen Castillo');
    await panel.getByLabel('Gender').selectOption({ label: 'Male' });
    const specialty = panel.getByRole('combobox', { name: 'Specialty' });
    await specialty.click();
    await specialty.fill('Exotic');
    await page.getByRole('listbox', { name: 'Choices for specialty' }).getByRole('option', { name: 'Add a specialty…' }).click();
    await panel.getByLabel('New specialty').fill('Exotic animals');
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(specialty).toHaveValue('Exotic animals');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('doctor')).toHaveCount(2);

    // edit one: Dr. Marsh does dentistry now
    await page.getByTestId('doctor').filter({ hasText: 'Dr. Elena Marsh' }).getByRole('button', { name: 'Edit hours and details' }).click();
    panel = page.getByRole('dialog', { name: 'Edit Dr. Elena Marsh' });
    await expect(panel.getByLabel('Licence number')).toHaveValue('CO-VET-0161');
    await pick(panel, 'Specialty', 'Dentistry');
    await panel.getByLabel('Qualifications and certifications').fill('DVM');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('doctor').filter({ hasText: 'Dr. Elena Marsh' })).toContainText('Dentistry');

    // the filter offers every specialty in use, the one added from the panel too
    const filter = page.getByLabel('Specialty', { exact: true });
    for (const s of ['Dentistry', 'Exotic animals']) await expect(filter.locator('option', { hasText: s })).toHaveCount(1);
    await filter.selectOption({ label: 'Exotic animals' });
    await expect(page.getByTestId('doctor')).toHaveCount(1);
    await expect(page.getByTestId('doctor')).toContainText('Dr. Owen Castillo');
    await filter.selectOption({ index: 0 });
    await expect(page.getByText(/our veterinarian/i)).toHaveCount(0);
    await watch.axe(page, 'Veterinarians');

    // and the list in Settings has it
    await page.goto(`${home}/settings/fields?tab=providers`);
    await expect(page.getByRole('listitem').filter({ hasText: 'Exotic animals' }).first()).toBeVisible();
  });

  /** The one pet form, as Pets and a new booking's "New pet" step both show it. */
  const fillPet = async (form: Locator, pet: { name: string; kind: string; birthday: string; sex: string; owner: string; last?: string }) => {
    await form.getByLabel('Pet\'s name').fill(pet.name);
    await pick(form, 'Kind of animal', pet.kind);
    await form.getByLabel('Birthday').fill(pet.birthday);
    await form.getByLabel('Sex').selectOption({ label: pet.sex });
    await form.getByLabel('Owner\'s first name').fill(pet.owner);
    if (pet.last) await form.getByLabel('Owner\'s last name').fill(pet.last);
    await form.getByLabel('Owner\'s phone').fill('(720) 555-0162');
  };

  await watch.step('4. Pets: two pets with one owner and one phone, a third from New booking, one household', {}, async () => {
    await open(page, 'Pets');
    await expect(page.getByRole('heading', { name: 'Pets' })).toBeVisible();
    await watch.axe(page, 'Pets, empty');
    await page.getByRole('button', { name: 'Add pet' }).click();
    let form = page.getByRole('dialog', { name: 'Add pet' });
    // the owner goes by one name
    await fillPet(form, { name: 'Biscuit', kind: 'Dog', birthday: '2021-04-12', sex: 'Male', owner: 'Marisol' });
    await watch.axe(page, 'Add pet');
    await form.getByRole('button', { name: 'Add pet' }).click();
    await expect(page.getByRole('heading', { name: 'Biscuit', exact: true })).toBeVisible();
    await watch.axe(page, 'a pet\'s page');

    await open(page, 'Pets');
    await page.getByRole('button', { name: 'Add pet' }).click();
    form = page.getByRole('dialog', { name: 'Add pet' });
    // a birthday in the future is refused under the field, before anything is sent
    await fillPet(form, { name: 'Pepper', kind: 'Cat', birthday: '2099-03-01', sex: 'Female', owner: 'Marisol' });
    await form.getByRole('button', { name: 'Add pet' }).click();
    await expect(form.getByText('A birthday can\'t be in the future.')).toBeVisible();
    await expect(form.getByLabel('Birthday')).toHaveAttribute('aria-invalid', 'true');
    await form.getByLabel('Birthday').fill('2023-08-20');
    await form.getByRole('button', { name: 'Add pet' }).click();
    await expect(page.getByRole('heading', { name: 'Pepper', exact: true })).toBeVisible();

    // the third from the Schedule's New booking, "New pet"
    await open(page, 'Schedule');
    await page.getByRole('button', { name: 'New booking' }).click();
    const booking = page.getByRole('dialog', { name: 'New booking' });
    await booking.getByRole('button', { name: 'Add a new pet' }).click();
    await fillPet(booking, { name: 'Clover', kind: 'Rabbit', birthday: '2024-02-02', sex: 'Female', owner: 'Marisol' });
    await watch.axe(page, 'New booking, New pet');
    await booking.getByRole('button', { name: 'Add and continue' }).click();
    await expect(booking.getByText('For Clover', { exact: true })).toBeVisible();
    await booking.getByRole('button', { name: 'Close' }).click();

    // one household: each pet's page lists the other two on the owner's phone
    for (const [pet, others] of [['Biscuit', ['Pepper', 'Clover']], ['Clover', ['Biscuit', 'Pepper']]] as const) {
      await open(page, 'Pets');
      await page.getByRole('link', { name: new RegExp(`^${pet}\\b`) }).first().click();
      await expect(page.getByRole('heading', { name: pet, exact: true })).toBeVisible();
      const household = page.getByTestId('household');
      await expect(household).toContainText('Marisol\'s pets on (720) 555-0162');
      for (const o of others) await expect(household.getByRole('link', { name: o, exact: true })).toBeVisible();
    }
  });

  /** The pet's page, from Pets. */
  const petPage = async (name: string) => {
    await open(page, 'Pets');
    await page.getByRole('link', { name: new RegExp(`^${name}\\b`) }).first().click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  };
  /** Books from the pet's page: a visit type, a vet, and the first open time from `weeksOut` weeks on. Returns its time as the panel says it. */
  const bookFromPet = async (name: string, visit: string, vet: string, weeksOut = 0) => {
    await petPage(name);
    await page.getByRole('button', { name: 'Book' }).click();
    const dialog = page.getByRole('dialog', { name: 'New booking' });
    await expect(dialog.getByText(`For ${name}`, { exact: true })).toBeVisible();
    await dialog.getByLabel('Visit type').selectOption({ label: visit });
    await dialog.getByLabel('Veterinarian', { exact: true }).selectOption({ label: vet });
    for (let i = 0; i < weeksOut; i++) await dialog.getByRole('button', { name: 'Later week' }).click();
    await dialog.getByRole('radio').first().click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    const when = (await dialog.locator('dt', { hasText: 'When' }).locator('xpath=following-sibling::dd[1]').textContent())!;
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog).toBeHidden();
    return when;
  };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());

  await watch.step('5. Booking: each pet booked, one moved, one cancelled; the Schedule, Today and the pet\'s page agree', {}, async () => {
    // Clover today, at the first open time; Biscuit and Pepper next week, clear of a visit about to start
    const clover = await bookFromPet('Clover', 'Wellness exam (30 min)', 'Dr. Owen Castillo');
    await bookFromPet('Biscuit', 'Sick visit (20 min)', 'Dr. Elena Marsh', 1);
    await bookFromPet('Pepper', 'Vaccine appointment (15 min)', 'Dr. Elena Marsh', 1);
    await watch.axe(page, 'a pet\'s page, with a visit');

    // Biscuit's moves to the week after
    await petPage('Biscuit');
    await page.getByRole('button', { name: 'Reschedule or cancel' }).click();
    let panel = page.getByRole('dialog', { name: 'Biscuit' });
    await watch.axe(page, 'a visit\'s panel');
    await panel.getByRole('button', { name: 'Reschedule' }).click();
    await panel.getByRole('button', { name: 'Later week' }).click();
    await panel.getByRole('button', { name: 'Later week' }).click();
    await panel.getByRole('radio').first().click();
    await panel.getByRole('button', { name: 'Move appointment' }).click();
    await expect(page.locator('[aria-live=polite]').getByText('Moved. The schedule shows the new time.')).toBeVisible();
    const moved = (await panel.getByText(/^\w+day \d+ \w+, \d/).textContent())!;
    await page.keyboard.press('Escape');

    // Pepper's is cancelled
    await petPage('Pepper');
    await page.getByRole('button', { name: 'Reschedule or cancel' }).click();
    panel = page.getByRole('dialog', { name: 'Pepper' });
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByLabel('Why is it cancelled?').selectOption({ index: 1 });
    await panel.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.locator('[aria-live=polite]').getByText('Cancelled. The time is free again.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('list').getByText('Cancelled', { exact: true })).toBeVisible();

    // the pets' pages
    await petPage('Clover');
    await expect(page.getByText(clover.replace(/^(\w+day \d+ \w+).* at /, '$1 at '), { exact: false }).first()).toBeVisible();
    // Biscuit's page has the new time, and the Schedule has it on that day
    const [movedDay, movedTime] = moved.split(' to ')[0]!.split(', ') as [string, string];
    await petPage('Biscuit');
    await expect(page.getByText('Upcoming', { exact: true })).toHaveCount(1);
    await expect(page.getByText(`${movedDay} at ${movedTime}`, { exact: true })).toBeVisible();
    const movedDate = [...Array(30).keys()].map((n) => new Date(Date.now() + n * 86_400_000))
      .find((d) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(d) === movedDay);
    expect(movedDate, `a date for ${movedDay}`).toBeTruthy();
    await page.goto(`${home}/schedule?view=day&date=${new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(movedDate)}`);
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator(`[data-testid=appointment][aria-label^="${movedTime}, Biscuit"]`)).toHaveCount(1);
    // Pepper's, cancelled, is not booked anywhere
    await petPage('Pepper');
    await expect(page.getByText('Upcoming', { exact: true })).toHaveCount(0);

    // Today: Clover with Dr. Castillo; nothing with Dr. Marsh
    await open(page, 'Today');
    const castillo = page.getByRole('region', { name: 'Dr. Owen Castillo' }).or(page.locator('section[aria-label="Dr. Owen Castillo"]'));
    await expect(castillo).toContainText('Clover');
    await expect(castillo).toContainText('1 booked');
    const marsh = page.locator('section[aria-label="Dr. Elena Marsh"]');
    await expect(marsh).toContainText('0 booked');
    await expect(marsh).not.toContainText('Biscuit');
    await expect(page.getByText(/our veterinarian/i)).toHaveCount(0);
    await watch.axe(page, 'Today, with visits');

    // the Schedule: today's day, then the week Biscuit's moved to
    await page.goto(`${home}/schedule?view=day&date=${today}`);
    await expect(page.getByTestId('schedule')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('[data-testid=appointment][aria-label*="Clover"]')).toHaveCount(1);
    await expect(page.locator('[data-testid=appointment][aria-label*="Biscuit"]')).toHaveCount(0);
    await expect(page.getByText(/our veterinarian/i)).toHaveCount(0);
    await watch.axe(page, 'Schedule, a day');
  });

  await watch.step('6. Requests: New request, "Added by" with the name and role, assign, release, mark done', {}, async () => {
    await open(page, /^Requests/);
    await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
    await watch.axe(page, 'Requests, empty');
    await page.getByRole('button', { name: 'New request' }).click();
    const form = page.getByRole('dialog', { name: 'New request' });
    await form.getByRole('button', { name: /^Callback/ }).click();
    await form.getByLabel('Name').fill('Marisol');
    await form.getByLabel('Call back on').fill('720 555 0162');
    await form.getByLabel('What it is about').fill('Asks whether Clover needs a nail trim at the same visit');
    await watch.axe(page, 'New request');
    await form.getByRole('button', { name: 'Add request' }).click();
    await expect(page.getByText('Request added. It is in the queue for the team.')).toBeVisible();

    const row = page.getByTestId('task-row').filter({ hasText: 'Marisol' });
    await expect(row).toContainText('Added by Avery Lindqvist-Hale');
    await expect(row).toContainText('Call back on (720) 555-0162');
    await row.click();
    const card = page.getByTestId('task');
    await expect(card.getByTestId('added-by')).toHaveText(/^Added by Avery Lindqvist-Hale \(Owner\), /);
    await watch.axe(page, 'a request');

    // assigned to the owner, the only one on the team so far, then released, then done
    const assign = card.getByLabel('Assign to');
    await assign.selectOption({ label: 'Avery Lindqvist-Hale (you)' });
    await expect(card.getByText('You have it')).toBeVisible();
    await card.getByRole('button', { name: 'Release' }).click();
    await expect(page.getByText('Released. It is back in the queue.')).toBeVisible();
    await expect(card.getByText('Unclaimed')).toBeVisible();
    await card.getByRole('button', { name: 'Mark done' }).click();
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(page.getByTestId('task-row').filter({ hasText: 'Marisol' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByTestId('task-row').filter({ hasText: 'Marisol' })).toContainText('Added by Avery Lindqvist-Hale');
  });

  // removed from their only team, the newcomer is signed out: their open page's next requests are turned away
  await watch.step('7. Team: a new email and an existing login invited, one removed, who then has no clinic', { responses: [{ who: 'the newcomer', path: /^\/api\//, status: 401 }] }, async () => {
    // someone with a login already: the owner of another clinic
    await hosting.openAccount('Stonebridge Veterinary', OTHER, '+17205550163');
    await open(page, 'Team');
    await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
    await watch.axe(page, 'Team');
    await page.getByRole('button', { name: 'Add people' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add people' });
    await dialog.getByLabel('Emails').fill(`${NEWCOMER.name} <${NEWCOMER.email}>\n${OTHER.email}`);
    await expect(dialog.getByTestId('person-row')).toHaveCount(2);
    await dialog.getByLabel(`Role for ${NEWCOMER.email}`).selectOption({ label: 'Front desk' });
    await dialog.getByLabel(`Role for ${OTHER.email}`).selectOption({ label: 'Practice manager' });
    await watch.axe(page, 'Add people');
    await dialog.getByRole('button', { name: 'Add 2 people' }).click();
    const sent = page.getByRole('dialog', { name: 'Invites sent' });
    for (const email of [NEWCOMER.email, OTHER.email]) await expect(sent.getByText(`${email}: invite sent`)).toBeVisible();
    const password = (await sent.getByTestId('temporary-password').textContent())!;
    await sent.getByRole('button', { name: 'Done' }).click();

    // the one with a login accepts from their own dashboard
    const other = await signIn(browser, watch, 'the other owner', OTHER.email, OTHER.password);
    await expect(other).toHaveURL(/\/c\/[^/]+$/, { timeout: 30_000 });
    const banner = other.getByTestId('invitation');
    await expect(banner).toContainText('Willow Bend Animal Clinic invited you to its team as Practice manager.');
    await banner.getByRole('button', { name: 'Accept' }).click();
    await expect(other.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();

    // the newcomer signs in with the temporary password, and picks their own
    const newcomer = await signIn(browser, watch, 'the newcomer', NEWCOMER.email, password);
    await expect(newcomer).toHaveURL(/\/change-password$/, { timeout: 20_000 });
    await newcomer.getByLabel('Temporary password').fill(password);
    await newcomer.getByLabel('New password', { exact: true }).fill('riley picks a long one');
    await newcomer.getByLabel('New password again').fill('riley picks a long one');
    await newcomer.getByRole('button', { name: 'Save my password' }).click();
    await expect(newcomer.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();

    // the owner sees both on the team, and removes the newcomer
    await page.reload();
    await expect(page.getByRole('row', { name: new RegExp(OTHER.name) })).toBeVisible();
    await page.getByRole('row', { name: new RegExp(NEWCOMER.name) }).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('dialog', { name: `Remove ${NEWCOMER.name}?` }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText(`${NEWCOMER.name} is off the team`)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(NEWCOMER.name) })).toHaveCount(0);

    // and the newcomer, signed out with it, signs in again and is told they are on no team now
    await newcomer.goto('/');
    await expect(newcomer).toHaveURL(/\/sign-in/);
    await newcomer.getByLabel('Email').fill(NEWCOMER.email);
    await newcomer.getByLabel('Password').fill('riley picks a long one');
    await signInPatiently(newcomer, () => newcomer.getByRole('button', { name: 'Sign in', exact: true }).click());
    await expect(newcomer.getByText('No clinic yet')).toBeVisible();
    await watch.axe(newcomer, 'No clinic yet');
  });

  let second = '';
  /** A stand-in for the hosting layer's account pages, which are another app on this address. */
  await page.route('**/account/**', (route) => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="en"><head><title>Plan and billing</title></head><body><main><h1>Plan and billing</h1><a href="/">Back to the dashboard</a></main></body></html>' }));

  await watch.step('8. Switcher: a second clinic, switch, an account page and back, still in the same clinic', {}, async () => {
    await page.goto(home);
    // "Create a new clinic" is the hosting layer's page; it opens the clinic as provisioning does
    const switcher = page.getByRole('button', { name: /Willow Bend Animal Clinic, Owner: switch clinic/ });
    await switcher.click();
    await watch.axe(page, 'the clinic switcher, open');
    await page.getByRole('menuitem', { name: /Create a new clinic/ }).click();
    await expect(page).toHaveURL(/\/account\/new-clinic$/);
    const opened = await hosting.openForOwner(first.userId, 'Juniper Hill Pet Care', '+17205550164');
    await hosting.plan(opened.clinicId);
    second = `/c/${opened.clinicId}`;
    await page.goto(second);
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Juniper Hill Pet Care, Owner: switch clinic/ })).toBeVisible();

    // switch to the first, then back to the second, with the switcher
    await page.getByRole('button', { name: /switch clinic/ }).click();
    await expect(page.getByRole('menuitemradio')).toHaveCount(2);
    await page.getByRole('menuitemradio', { name: /Willow Bend Animal Clinic/ }).click();
    await expect(page.getByText('Now in Willow Bend Animal Clinic.')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${home}$`));
    await page.getByRole('button', { name: /switch clinic/ }).click();
    await page.getByRole('menuitemradio', { name: /Juniper Hill Pet Care/ }).click();
    await expect(page.getByText('Now in Juniper Hill Pet Care.')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${second}$`));

    // an account page, and back to the dashboard: still in Juniper Hill
    await page.getByRole('link', { name: 'Plan and billing' }).first().click();
    await expect(page.getByRole('heading', { name: 'Plan and billing' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to the dashboard' }).click();
    await expect(page).toHaveURL(new RegExp(`${second}$`), { timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Juniper Hill Pet Care, Owner: switch clinic/ })).toBeVisible();
  });

  await watch.step('9. Test call: the simulated call, moving between pages with the call bar, hung up from the bar', {}, async () => {
    await page.goto(home);
    await open(page, 'Test call');
    await expect(page.getByRole('heading', { name: 'Test call' })).toBeVisible();
    await watch.axe(page, 'Test call');
    await page.getByRole('button', { name: 'Play a simulated call' }).click();
    await expect(page).toHaveURL(/\/calls\/[^/]+\/live$/, { timeout: 20_000 });
    const callId = new URL(page.url()).pathname.split('/')[4]!;
    const bar = page.getByRole('region', { name: 'Test call in progress' });
    await expect(bar).toContainText('Simulated call');
    await watch.axe(page, 'a live call');
    const live = async () => ((await (await page.request.get(`/api/v1/clinics/${first.clinicId}/live`)).json()) as { calls: { callId: string }[] }).calls.map((c) => c.callId);

    await open(page, 'Calls');
    await expect(page).toHaveURL(new RegExp(`${home}/calls$`));
    await expect(bar.getByTestId('call-bar-status')).toHaveText(/^\d+:\d{2}$/);
    await watch.axe(page, 'Calls, with the call bar');
    await open(page, 'Pets');
    await expect(bar).toBeVisible();
    expect(await live()).toContain(callId);
    await bar.getByRole('link', { name: 'Back to Test call' }).click();
    await expect(page).toHaveURL(new RegExp(`${home}/test-call$`));
    await bar.getByRole('button', { name: 'Hang up' }).click();
    await expect(bar).toHaveCount(0);
    await expect.poll(live, { timeout: 30_000 }).not.toContain(callId);
  });
});
