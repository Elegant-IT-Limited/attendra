import { countOf } from '@attendra/core';
import { expect, type Page, test } from '@playwright/test';
import { openAs, signInAgain } from './session';

// Fix batch 2026-11-26 on the demo vet clinic's made-up data (555-01xx numbers): Today and Texts count texts not
// handled over one window, from one count on the server, and say the window (SMALL-2); the visit's break says it may
// run past closing (FND-1115-6). Every shown value is checked against what the server sends.
type Summary = { today: { sent: number; notSent: number }; week: { sent: number; notSent: number }; needsHandling: number; todayDate: string; weekFrom: string };
type Problems = { total: number; from?: string; problems: { textId: string; taskId: string }[] };
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
const SIZES = [{ name: 'desktop', width: 1280, height: 800 }, { name: 'tablet', width: 768, height: 1024 }, { name: 'phone', width: 390, height: 844 }];
async function shots(page: Page, name: string, locator?: ReturnType<Page['locator']>) {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await (locator ?? page).screenshot({ path: `${dir}/${name}-${s.name}.png`, ...(locator ? {} : { fullPage: true }) });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe.serial('SMALL-2', () => {
  let page: Page;
  let C: string;
  let origin = '';
  async function call<T>(method: string, path: string, data?: unknown): Promise<T> {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { origin } });
    expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
    return (res.status() === 204 ? undefined : await res.json()) as T;
  }
  test.beforeAll(async ({ browser }) => {
    page = await signInAgain(browser, 'Vet clinic manager');
    C = clinicOf(page);
    origin = new URL(page.url()).origin;
  });
  // nothing left for later specs to see on Today or in the notice
  test.afterAll(async () => {
    for (const p of (await call<Problems>('GET', `/clinics/${C}/tasks/text-problems`)).problems) await call('POST', `/clinics/${C}/texts/${p.textId}/handled`, { handled: true });
  });

  test('SMALL-2: Today\'s count of texts not sent and not handled is the Texts page\'s, one 7-day count of every kind on the server, in the same words', async () => {
    // two refills closed as ready to pick up: the demo has no Twilio, so each text is recorded as not sent (by the
    // worker, a moment later). The demo's own reminders not sent count too (every kind), and the worker may add one at
    // any moment: each shown number is compared with the server's at the same moment
    // no dashboard page open meanwhile (as TX2): the page left on Today since sign-in would tell of the new texts
    // itself, as soon as they are recorded, and mark them seen, so the Today opened below would have no notice left
    await page.goto('about:blank');
    const mine: string[] = [];
    for (const i of [1, 2]) {
      const made = await call<{ id: string }>('POST', `/clinics/${C}/tasks`, { type: 'refill', medication: `Carprofen S2-${i}`, callbackNumber: `(720) 555-01${60 + i}` });
      await call('POST', `/clinics/${C}/tasks/${made.id}/done`, { outcome: 'refill_ready' });
      mine.push(made.id);
    }
    // wait for these two texts themselves: the total counts every kind now, so a reminder the worker records meanwhile
    // could reach any total first, and Today would open before the texts its notice is about
    await expect.poll(async () => {
      const listed = new Set((await call<Problems>('GET', `/clinics/${C}/tasks/text-problems`)).problems.map((p) => p.taskId));
      return mine.every((id) => listed.has(id));
    }, { timeout: 30_000 }).toBe(true);
    // one source of truth: the same count and the same first day, whichever endpoint answers
    const both = async () => {
      const [problems, summary] = await Promise.all([call<Problems>('GET', `/clinics/${C}/tasks/text-problems`), call<Summary>('GET', `/clinics/${C}/texts/summary`)]);
      return { problems, summary };
    };
    await expect(async () => {
      const { problems, summary } = await both();
      expect(problems.total).toBe(summary.needsHandling);
      expect(problems.from).toBe(summary.weekFrom);
    }).toPass({ timeout: 30_000 });
    const { summary } = await both();

    await page.goto(`/c/${C}`);
    // the notice for the new texts comes first (one per batch the browser has not been told of): read and closed
    const notice = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: /texts? (was|were) not sent/ });
    await expect(notice.first()).toBeVisible();
    const item = page.getByRole('list', { name: 'Needs attention' }).getByRole('listitem').filter({ has: page.getByTestId('texts-not-sent-review') });
    await expect(async () => {
      if (await notice.first().isVisible()) await notice.first().getByRole('button', { name: /OK|Close|Got it/ }).first().click();
      await expect(item).toHaveCount(1, { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await expect(async () => {
      const n = (await both()).summary.needsHandling;
      await expect(item).toContainText(`${countOf(n, 'text')} not sent in the last 7 days · Review`, { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await shots(page, 'small-2-today', item);

    // Review: every kind, not sent and not handled, from the window's first day
    await item.getByRole('link', { name: 'Review' }).click();
    await expect(page).toHaveURL(new RegExp(`/texts\\?status=needs_handling&from=${summary.weekFrom}$`));
    await expect(async () => {
      const n = (await both()).summary.needsHandling;
      await expect(page.getByTestId('needs-handling')).toHaveText(`${countOf(n, 'text')} not sent in the last 7 days`, { timeout: 1000 });
      await expect(page.getByTestId('summary-to-handle')).toHaveText(`To handle: ${countOf(n, 'text')} not sent in the last 7 days`, { timeout: 1000 });
      await expect(page.getByTestId('text-row')).toHaveCount(Math.min(n, 10), { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await shots(page, 'small-2-texts', page.getByTestId('texts-summary'));

    // the strip's "not sent" link shows every kind again, whatever kind was picked before (pick resets it)
    await page.getByLabel('Kind').selectOption('refills');
    await page.getByTestId('week-not-sent').click();
    await expect(page.getByLabel('Kind')).toHaveValue('');
    await expect(page).not.toHaveURL(/kind=/);
  });
});

test.describe('FND-1115-6', () => {
  test('FND-1115-6: the break after a visit says it may run past closing time', async ({ browser }) => {
    const page = await openAs(browser, 'manager');
    await page.goto(`/c/${clinicOf(page)}/settings#visits`);
    const row = page.locator('#visits [data-sortable-item]').first();
    await row.getByTestId('visit-more-options').locator('summary').click();
    const buffer = row.getByLabel(/break after, in minutes/);
    await expect(buffer).toBeVisible();
    await expect(buffer).toHaveAccessibleDescription('Kept free after each visit, for cleaning or notes, on calls and at the desk. It may run past closing time: the last visit of the day still ends by closing.');
    await shots(page, 'fnd-1115-6-break-hint', row);
  });
});
