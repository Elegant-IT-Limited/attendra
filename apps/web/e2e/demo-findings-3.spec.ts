import { expect, type Page, test } from '@playwright/test';
import { signInAgain } from './session';

// Demo findings 3 (2026-11-16), with made-up data on the demo vet clinic: Requests search finds a clinic's own kind by
// its name (item 2); renaming a kind carries the new name to its requests (item 3); a text that failed after the panel
// closed is on the request's row, on Today and in a notice that stays until read (item 4, the failed text stubbed:
// the e2e stack runs no worker). Each shown value is checked against what the server sends.
type Settings = Record<string, unknown> & { customFields?: unknown[]; providerFields?: unknown[]; requestFields?: unknown[]; requestTopics?: { id: string; name: string }[] };
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { origin: new URL(page.url()).origin } });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}
const fields = (s: Settings, requestTopics: unknown) => ({ customFields: s.customFields ?? [], providerFields: s.providerFields ?? [], requestFields: s.requestFields ?? [], requestTopics });
type Served = { id: string; number: number; details: Record<string, string> };

test.describe.serial('demo findings 3, 2026-11-16', () => {
  let page: Page;
  let C: string;
  let original: Settings;
  let mine: Served;
  test.beforeAll(async ({ browser }) => {
    page = await signInAgain(browser, 'Vet clinic manager');
    C = clinicOf(page);
    original = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    await call(page, 'PUT', `/clinics/${C}/settings/fields`, fields(original, [...(original.requestTopics ?? []).filter((t) => t.id !== 'topic_f3'), { id: 'topic_f3', name: 'Kennel stay' }]));
    const made = await call<{ id: string }>(page, 'POST', `/clinics/${C}/tasks`, { type: 'callback', topic: 'Kennel stay', reason: 'Four nights from Thursday', callbackNumber: '(720) 555-0179' });
    mine = (await call<{ tasks: Served[] }>(page, 'POST', `/clinics/${C}/tasks/search`, { status: 'open', q: 'Four nights from Thursday' })).tasks.find((t) => t.id === made.id)!;
  });
  test.afterAll(async () => {
    const now = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    await call(page, 'PUT', `/clinics/${C}/settings/fields`, fields(now, original.requestTopics ?? []));
  });

  test('item 2: Requests search finds a request by its own kind\'s name', async () => {
    await page.goto(`/c/${C}/requests`);
    await page.getByPlaceholder(/R-1042/).first().fill('Kennel stay');
    const row = page.getByTestId('task-row').filter({ has: page.getByTestId('request-number').getByText(`R-${mine.number}`, { exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('request-kind')).toHaveText(mine.details.topic!);
    // and every row the search shows is one the server found for those words
    const server = (await call<{ tasks: Served[] }>(page, 'POST', `/clinics/${C}/tasks/search`, { status: 'open', q: 'Kennel stay' })).tasks;
    await expect(page.getByTestId('task-row')).toHaveCount(server.length);
  });

  test('item 3: renaming the kind carries the new name to its requests', async () => {
    const now = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    await call(page, 'PUT', `/clinics/${C}/settings/fields`, fields(now, (now.requestTopics ?? []).map((t) => (t.id === 'topic_f3' ? { ...t, name: 'Boarding stay' } : t))));
    const served = (await call<{ tasks: Served[] }>(page, 'POST', `/clinics/${C}/tasks/search`, { status: 'open', q: 'Four nights from Thursday' })).tasks.find((t) => t.id === mine.id)!;
    expect(served.details.topic).toBe('Boarding stay');
    await page.goto(`/c/${C}/requests`);
    const row = page.getByTestId('task-row').filter({ has: page.getByTestId('request-number').getByText(`R-${mine.number}`, { exact: true }) });
    await expect(row.getByTestId('request-kind')).toHaveText('Boarding stay');
    await page.getByPlaceholder(/R-1042/).first().fill('Boarding stay');
    await expect(row).toHaveCount(1);
  });

  test('item 4: a text that failed after the panel closed is on the row, on Today and in a notice that stays', async () => {
    const failed = { status: 'failed', failureReason: null, errorCode: '30006', at: new Date(Date.now() - 60_000).toISOString() };
    const problem = { textId: 'f3-text-1', taskId: mine.id, number: mine.number, type: 'callback', taskStatus: 'open', ...failed };
    // the worker's result, as the API would send it once the carrier refused the text
    await page.route('**/api/v1/clinics/*/tasks/text-problems', (r) => r.fulfill({ json: { total: 1, problems: [problem] } }));
    await page.route('**/api/v1/clinics/*/tasks/search', async (r) => {
      const res = await r.fetch();
      const body = await res.json() as { tasks: (Served & { textProblem?: unknown })[] };
      await r.fulfill({ response: res, json: { ...body, tasks: body.tasks.map((t) => (t.id === mine.id ? { ...t, textProblem: failed } : t)) } });
    });
    await page.goto(`/c/${C}`);
    // the notice, wherever the person is: it stays until read
    // "1 text was not sent" (texts polish TX6)
    const notice = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: '1 text was not sent' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`R-${mine.number} · Callback: Text not sent: the carrier refused it (error 30006)`);
    await page.waitForTimeout(1500);
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: /OK|Close|Got it/ }).first().click();
    await expect(notice).toBeHidden();
    // Today: one item for it, with the same words (texts not sent are one item since texts polish TX2)
    const item = page.getByText('1 text not sent · Review', { exact: true });
    await expect(item).toBeVisible();
    await expect(page.getByText(`R-${mine.number} · Callback: Text not sent: the carrier refused it (error 30006).`, { exact: false }).first()).toBeVisible();
    // said once in this browser: back on Today, no notice again
    await page.reload();
    await expect(item).toBeVisible();
    await expect(notice).toHaveCount(0);
    // the row says it too
    await page.goto(`/c/${C}/requests`);
    const row = page.getByTestId('task-row').filter({ has: page.getByTestId('request-number').getByText(`R-${mine.number}`, { exact: true }) });
    await expect(row.getByTestId('text-not-sent')).toHaveText('Text not sent');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
