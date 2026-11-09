import { expect, test } from '@playwright/test';
import { openAs } from './session';

// Batch 4b: how an animal's emergency ended, on the Calls list, and the filter for it that the API answers (CALL-2);
// the longest wait and the questions asked again on the call page (CALL-3). The demo clinic's recorded calls; made-up
// callers only. The demo has no animal emergency with a result (those scenarios are kept out of the demo), so the row's
// label is checked on a page whose first call the server's own answer is changed for.
const LABELS: Record<string, string> = {
  transferred: 'Emergency · put through', hospital_said: 'Emergency · sent to hospital', hospital_texted: 'Emergency · hospital texted',
  urgent_request: 'Emergency · urgent request', cleared: 'Emergency cleared',
};

test('the Calls list asks the server for how an emergency ended, and says each result in plain words', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  await page.getByRole('link', { name: 'Calls', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  // every result is an option, and choosing one is a filter the server answers, a page at a time
  for (const label of Object.values(LABELS)) await expect(page.getByLabel('Emergency result').locator('option', { hasText: label })).toHaveCount(1);
  const asked = page.waitForRequest((r) => r.url().includes('/calls?') && r.url().includes('emergencyResult=transferred') && r.url().includes('limit=50'));
  await page.getByLabel('Emergency result').selectOption({ label: LABELS.transferred! });
  await asked;
  // the demo's emergencies are a person's (the 911 line), never put through by the animal state machine
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByLabel('Emergency result')).toHaveValue('');
  await expect(page.locator('tbody tr').first()).toBeVisible();

  // a call the server says ended with the hospital texted shows that, not only "Emergency"
  await page.route((u) => /\/api\/v1\/clinics\/[^/]+\/calls$/.test(u.pathname), async (route) => {
    const res = await route.fetch();
    const body = await res.json() as { calls: { emergency: boolean; emergencyResult?: string | null }[] };
    body.calls[0] = { ...body.calls[0]!, emergency: true, emergencyResult: 'hospital_texted' };
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  await expect(page.locator('tbody tr').first()).toContainText(LABELS.hospital_texted!);
});

test('a call page says how the call went for the caller, and how it ended in plain words', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  await page.getByRole('link', { name: 'Calls', exact: true }).click();
  await page.getByRole('tab', { name: 'Bookings and changes' }).click();
  await page.locator('tbody tr').first().getByRole('link').click();
  await expect(page).toHaveURL(/\/calls\/[^/]+$/);
  await expect(page.getByRole('heading', { name: 'How it went for the caller' })).toBeVisible();
  await expect(page.getByTestId('longest-wait')).toContainText(/Longest wait after they spoke\s*(\d+\.\d s|No reply to time)/);
  await expect(page.getByTestId('repeated-questions')).toContainText(/Questions asked again\s*\d/);
  await expect(page.getByTestId('close-reason')).toContainText(/Caller hung up|Transferred/);
});

test('every outcome is an option in the Calls filters, the caller who heard nothing included', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  await page.getByRole('link', { name: 'Calls', exact: true }).click();
  await expect(page.getByLabel('Outcome').locator('option', { hasText: 'Caller heard nothing' })).toHaveCount(1);
  await expect(page.getByLabel('Channel').locator('option')).toHaveText(['Any channel', 'Phone', 'Browser test']);
});

test('the Calls search hint is whole at desktop, laptop and phone widths, for a vet clinic\'s words too', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2]!;
  await page.goto(`/c/${clinic}/calls`);
  const search = page.locator('#call-search');
  // the room the text has inside the box, against the hint in the box's own font; the vet clinic's hint is measured in the same box
  const fits = async () => search.evaluate((el: HTMLInputElement, texts: string[]) => {
    const css = getComputedStyle(el);
    const room = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    return texts.map((t) => ({ t, fits: ctx.measureText(t).width <= room }));
  }, [(await search.getAttribute('placeholder'))!, 'Pet, owner, phone or R-1042']);
  for (const width of [1440, 1280, 1024, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(search).toBeVisible();
    expect(await fits(), `at ${width}px`).toEqual([expect.objectContaining({ fits: true }), expect.objectContaining({ fits: true })]);
  }
});
