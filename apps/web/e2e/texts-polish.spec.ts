import { countOf, textsNotSent } from '@attendra/core';
import { expect, type Page, test } from '@playwright/test';
import { signInAgain } from './session';

// Texts polish (2026-11-17), on the demo vet clinic's made-up texts (60+ seeded, 555-01xx numbers): the Settings
// preview is the text that goes out (TX1); texts not sent are one Today item, after emergencies and unclaimed requests,
// each marked handled with who and when (TX2); the Texts page, short and searchable (TX3); a household's texts say
// which pet each was about (TX4); texts from before the words were kept say so (TX5); counts read right (TX6). Each
// shown value is checked against what the server sends.
type Text = { id: string; template: string; status: string; body: string | null; taskNumber: number | null; patientId: string | null; patientFirstName: string | null; toLast4: string | null; createdAt: string; handledBy: string | null };
type Page_ = { texts: Text[]; next: string | null; wordsKeptSince: string | null };
type Summary = { today: { sent: number; notSent: number }; week: { sent: number; notSent: number }; needsHandling: number; todayDate: string; weekFrom: string };
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { origin: new URL(page.url()).origin } });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const PILL: Record<string, string> = { delivered: 'Delivered', sent: 'Sent', queued: 'Waiting', not_sent: 'Not sent', failed: 'Not sent', undelivered: 'Not sent' };

test.describe.serial('texts polish', () => {
  let page: Page;
  let C: string;
  const search = (body: Record<string, unknown>) => call<Page_>(page, 'POST', `/clinics/${C}/texts/search`, body);
  const problems = () => call<{ total: number; problems: { textId: string; number: number }[] }>(page, 'GET', `/clinics/${C}/tasks/text-problems`);
  test.beforeAll(async ({ browser }) => {
    page = await signInAgain(browser, 'Vet clinic manager');
    C = clinicOf(page);
  });
  // nothing left for the specs after this one to see on Today or in the notice
  test.afterAll(async () => {
    for (const p of (await problems()).problems) await call(page, 'POST', `/clinics/${C}/texts/${p.textId}/handled`, { handled: true });
  });

  test('the demo clinic has 60+ texts to work with', async () => {
    let n = 0;
    let cursor: string | null = null;
    do { const p: Page_ = await search({ limit: 50, ...(cursor ? { cursor } : {}) }); n += p.texts.length; cursor = p.next; } while (cursor);
    expect(n).toBeGreaterThanOrEqual(60);
  });

  test('TX1: Settings shows a refill text as it goes out: the request\'s number, never "Hi <owner>"', async () => {
    const sent = (await search({ kind: 'request_ready', status: 'sent', limit: 50 })).texts.find((t) => t.body)!;
    await page.goto(`/c/${C}/settings/texting`);
    const template = page.getByTestId('text-request_ready');
    await expect(template).toContainText('{Request number}');
    await expect(template).not.toContainText('Hi {');
    await expect(template).not.toContainText("Owner's first name");
    // the example, with made-up names, reads as the words the server kept for a real one, names aside
    await template.locator('xpath=ancestor::li[1]').getByRole('button', { name: 'Add your words' }).click();
    await page.getByText('See it as a client gets it, with made-up names').first().click();
    const example = await page.getByTestId('preview-request_ready-en').innerText();
    expect(example).toBe(sent.body!.replace(/Biscuit|Mochi|Pepper|Luna/, 'Max').replace(/R-\d+/, 'R-12'));
  });

  test('TX2: texts not sent are one Today item, after emergencies and unclaimed requests, and Handled takes one off', async () => {
    // three refills closed as ready to pick up: the demo has no Twilio, so each text is recorded as not sent
    for (const i of [1, 2, 3]) {
      const made = await call<{ id: string }>(page, 'POST', `/clinics/${C}/tasks`, { type: 'refill', medication: `Carprofen ${i}`, callbackNumber: `(720) 555-01${80 + i}` });
      await call(page, 'POST', `/clinics/${C}/tasks/${made.id}/done`, { outcome: 'refill_ready' });
    }
    await expect.poll(async () => (await problems()).total, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    const { total } = await problems();
    await page.goto(`/c/${C}`);
    // the notice, for the texts this browser has not been told of yet: "1 text was not sent", "2 texts were not sent"
    const notice = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: /^\d+ texts? (was|were) not sent/ });
    await expect(notice.first()).toBeVisible();
    const heading = (await notice.first().getByRole('heading').innerText()).trim();
    expect(heading).toBe(textsNotSent(Number(heading.split(' ')[0])));
    await notice.first().getByRole('button', { name: /OK|Close|Got it/ }).first().click();
    const list = page.getByRole('list', { name: 'Needs attention' });
    const item = list.getByRole('listitem').filter({ hasText: `${countOf(total, 'text')} not sent · Review` });
    await expect(item).toHaveCount(1);
    // no row per text any more
    await expect(list.getByText(/^Text not sent · R-/)).toHaveCount(0);
    // emergencies and unclaimed requests come first
    const titles = await list.getByRole('listitem').allInnerTexts();
    const at = titles.findIndex((t) => t.includes('not sent · Review'));
    titles.forEach((t, i) => { if (/Emergency|nobody has it yet/.test(t)) expect(i, t).toBeLessThan(at); });
    await expect(page.getByTestId('attention-count')).toHaveText(countOf(titles.length, 'item'));
    // Review: the Texts page, with exactly those texts
    await item.getByRole('link', { name: 'Review' }).click();
    await expect(page).toHaveURL(/\/texts\?status=needs_handling&kind=refills&from=/);
    const from = new URL(page.url()).searchParams.get('from')!;
    const server = await search({ status: 'needs_handling', kind: 'refills', from, limit: 50 });
    expect(server.texts.length).toBe(total);
    await expect(page.getByTestId('text-row')).toHaveCount(Math.min(total, 10));
    // mark the newest handled: who and when, and it leaves Today
    const row = page.locator(`[data-text-id="${server.texts[0]!.id}"]`);
    await row.getByRole('button').first().click();
    await row.getByTestId('text-mark-handled').click();
    await expect(page.getByText('Marked handled. It is off Today.')).toBeVisible();
    await expect.poll(async () => (await problems()).total).toBe(total - 1);
    const handled = (await search({ status: 'not_sent', kind: 'refills', limit: 50 })).texts.find((t) => t.id === server.texts[0]!.id)!;
    expect(handled.handledBy).toMatch(/Robin/);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.locator(`[data-text-id="${handled.id}"]`).getByRole('button').first().click();
    await expect(page.locator(`[data-text-id="${handled.id}"]`).getByTestId('text-handled')).toContainText(`Handled by ${handled.handledBy}`);
    await page.goto(`/c/${C}`);
    await expect(list.getByRole('listitem').filter({ hasText: `${countOf(total - 1, 'text')} not sent · Review` })).toHaveCount(total - 1 ? 1 : 0);
  });

  test('TX3: the Texts page: a short intro, the strip, 10 rows by day, more on request', async () => {
    const settings = await call<{ retentionDays: number }>(page, 'GET', `/clinics/${C}/settings`);
    const summary = await call<Summary>(page, 'GET', `/clinics/${C}/texts/summary`);
    await page.goto(`/c/${C}/texts`);
    await expect(page.getByText(`Texts sent to your clients. Words are kept ${settings.retentionDays} days.`)).toBeVisible();
    await expect(page.getByTestId('summary-today')).toHaveText(`Today: ${summary.today.sent} sent · ${summary.today.notSent} not sent`);
    await expect(page.getByTestId('summary-week')).toHaveText(`Last 7 days: ${summary.week.sent} sent · ${summary.week.notSent} not sent`);
    const first = await search({ limit: 10 });
    await expect(page.getByTestId('text-row')).toHaveCount(10);
    for (const [i, t] of first.texts.entries()) {
      const row = page.getByTestId('text-row').nth(i);
      await expect(row).toHaveAttribute('data-text-id', t.id);
      await expect(row.getByTestId('text-status')).toHaveText(PILL[t.status]!);
    }
    await expect(page.getByTestId('text-day').first().getByRole('heading')).toHaveText(/^(Today|Yesterday|\w{3} \d{1,2} \w{3})$/);
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.getByTestId('text-row')).toHaveCount(30);
    // a strip count is a filter: the week's "not sent"
    await page.getByTestId('week-not-sent').click();
    const notSent = await search({ status: 'not_sent', from: summary.weekFrom, limit: 50 });
    await expect(page.getByTestId('text-row')).toHaveCount(Math.min(notSent.texts.length, 10));
    for (const pill of await page.getByTestId('text-status').allInnerTexts()) expect(pill).toBe('Not sent');
    // why it was not sent is in the row's details, not on the row
    const failedRow = page.getByTestId('text-row').first();
    await failedRow.getByRole('button').first().click();
    await expect(failedRow.getByTestId('text-why')).toHaveText(/^Not sent: .+\.$/);
  });

  test('TX3: search by pet, owner, last four and request number; filter by kind and dates', async () => {
    await page.goto(`/c/${C}/texts`);
    const box = page.getByLabel('Find a text');
    for (const q of ['Pepper', 'Ortiz', '0174']) {
      await box.fill(q);
      const server = await search({ q, limit: 10 });
      expect(server.texts.length, q).toBeGreaterThan(0);
      await expect(page.getByTestId('text-row')).toHaveCount(server.texts.length);
      await expect(page.getByTestId('text-row').first()).toHaveAttribute('data-text-id', server.texts[0]!.id);
    }
    const withRef = (await search({ kind: 'refills', limit: 50 })).texts.find((t) => t.taskNumber)!;
    await box.fill(`R-${withRef.taskNumber}`);
    const byRef = await search({ q: `R-${withRef.taskNumber}`, limit: 10 });
    await expect(page.getByTestId('text-row')).toHaveCount(byRef.texts.length);
    await page.getByTestId('text-row').first().getByRole('button').first().click();
    await expect(page.getByTestId('text-request').first()).toHaveText(`R-${withRef.taskNumber}`);
    await box.fill('');
    await page.getByLabel('Kind', { exact: true }).selectOption('reminder');
    const reminders = await search({ kind: 'reminder', limit: 10 });
    await expect(page.getByTestId('text-row')).toHaveCount(reminders.texts.length);
    for (const k of await page.getByTestId('text-kind').allInnerTexts()) expect(k).toBe('Reminder before a visit');
    const day = (await search({ limit: 50 })).texts.at(-1)!.createdAt;
    const settings = await call<{ timezone: string }>(page, 'GET', `/clinics/${C}/settings`);
    const local = new Date(day).toLocaleDateString('en-CA', { timeZone: settings.timezone });
    await page.getByLabel('Kind', { exact: true }).selectOption('');
    await page.getByLabel('From', { exact: true }).fill(local);
    await page.getByLabel('To', { exact: true }).fill(local);
    const onDay = await search({ from: local, to: local, limit: 10 });
    await expect(page.getByTestId('text-row')).toHaveCount(onDay.texts.length);
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(page.getByTestId('text-row')).toHaveCount(10);
  });

  test('TX4 and TX5: a household\'s texts say which pet each was about, and old ones say their words were not kept', async () => {
    const pets = await call<{ patients: { id: string; name: string }[] }>(page, 'GET', `/clinics/${C}/patients`);
    const mochi = pets.patients.find((p) => p.name.startsWith('Mochi'))!;
    const server = await call<{ texts: Text[]; wordsKeptSince: string }>(page, 'GET', `/clinics/${C}/texts?patientId=${mochi.id}`);
    expect(server.texts.some((t) => t.patientFirstName === 'Biscuit')).toBe(true);
    await page.goto(`/c/${C}/patients/${mochi.id}`);
    await page.getByRole('tab', { name: /^Texts/ }).click();
    const rows = page.getByTestId('text-row');
    await expect(rows).toHaveCount(server.texts.length);
    for (const [i, t] of server.texts.entries()) await expect(rows.nth(i).getByTestId('text-about')).toHaveText(t.patientFirstName ? `about ${t.patientFirstName}` : 'about the household');
    // a text from before the clinic kept words
    const all = await search({ status: 'sent', limit: 50 });
    let old = all.texts.find((t) => !t.body);
    let cursor = all.next;
    while (!old && cursor) { const p = await search({ status: 'sent', limit: 50, cursor }); old = p.texts.find((t) => !t.body); cursor = p.next; }
    expect(old).toBeTruthy();
    const settings = await call<{ timezone: string }>(page, 'GET', `/clinics/${C}/settings`);
    const since = new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, day: 'numeric', month: 'short' }).format(new Date(server.wordsKeptSince));
    await page.goto(`/c/${C}/texts`);
    await page.getByLabel('From', { exact: true }).fill(new Date(old!.createdAt).toLocaleDateString('en-CA', { timeZone: settings.timezone }));
    await page.getByLabel('To', { exact: true }).fill(new Date(old!.createdAt).toLocaleDateString('en-CA', { timeZone: settings.timezone }));
    const row = page.locator(`[data-text-id="${old!.id}"]`);
    await row.getByRole('button').first().click();
    await expect(row.getByTestId('text-no-words')).toHaveText(`Words not kept (sent before ${since})`);
  });

  test('phone width: Texts fits, each row at most two lines (a pet\'s tab: text-history.spec)', async () => {
    await page.setViewportSize({ width: 400, height: 844 });
    await page.goto(`/c/${C}/texts`);
    await expect(page.getByTestId('text-row').first()).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    for (const h of await page.getByTestId('text-row').locator('> button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeLessThan(64);
    await page.setViewportSize({ width: 1380, height: 900 });
    for (const h of await page.getByTestId('text-row').locator('> button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeLessThan(48);
  });
});
