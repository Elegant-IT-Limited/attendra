import { expect, test } from '@playwright/test';
import { openAs } from './session';

test('a request written down at the desk says who added it, is named as typed, and its number reads as people write it and calls it', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  await page.getByRole('link', { name: /^Requests/ }).click();
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();

  // one with a name typed, one without
  const add = async (name: string, reason: string) => {
    await page.getByRole('button', { name: 'New request' }).click();
    const form = page.getByRole('dialog', { name: 'New request' });
    if (name) await form.getByLabel('Name').fill(name);
    await form.getByLabel('Call back on').fill('505 555 0142');
    await form.getByLabel('What it is about').fill(reason);
    await form.getByRole('button', { name: 'Add request' }).click();
    await expect(page.getByText('Request added. It is in the queue for the team.')).toBeVisible();
    await expect(form).toHaveCount(0);
  };
  await add('Dana Whitfield', 'Wants to move her daughter to a new doctor');
  await add('', 'Left a voicemail about parking');

  const rows = page.getByTestId('task-row');
  const named = rows.filter({ hasText: 'Dana Whitfield' });
  // the row's second line names who added it, and the number reads as people write it
  await expect(named).toContainText('Added by Jordan (front desk)');
  await expect(named).toContainText('Call back on (505) 555-0142');
  // no record and no name typed: it says so, never "Caller not verified"
  const unnamed = rows.filter({ hasText: 'Left a voicemail about parking' });
  await expect(unnamed).toContainText('No patient linked');
  await expect(unnamed).not.toContainText('Caller not verified');

  await named.click();
  const card = page.getByTestId('task');
  await expect(card.getByTestId('added-by')).toHaveText(/^Added by Jordan \(front desk\) \(Front desk\), \w{3} \d{1,2} \w{3} \d{1,2}:\d{2} [AP]M$/);
  await expect(card.getByRole('link', { name: '(505) 555-0142' })).toHaveAttribute('href', 'tel:+15055550142');

  // the urgency control is an action that says what it will do; the badge says what it is now
  await card.getByRole('button', { name: 'Mark urgent' }).click();
  await expect(card.getByText('Urgent', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Mark not urgent' }).click();
  await expect(card.getByRole('button', { name: 'Mark urgent' })).toBeVisible();

  // closed, it keeps the same line in Done
  await card.getByRole('button', { name: 'Mark done' }).click();
  await card.getByRole('button', { name: 'Mark done' }).click();
  await expect(card).toHaveCount(0);
  await unnamed.click();
  await page.getByTestId('task').getByRole('button', { name: 'Mark done' }).click();
  await page.getByTestId('task').getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByTestId('task')).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(rows.filter({ hasText: 'Dana Whitfield' }).first()).toContainText('Added by Jordan (front desk)');
});

// Note 52 C8 and C9: New request's example fits the kind chosen (a refill showed a dental cleaning); "Added by …" is
// never cut in the list; the note after adding stays off the list's right column; and the audit log records the
// request once, by its number, with no "changed" row for a change nobody made.
test('New request shows an example per kind; the list never cuts who added it; the note and the audit log say it right', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/requests`);
  await page.getByRole('button', { name: 'New request' }).click();
  const form = page.getByRole('dialog', { name: 'New request' });
  const reason = form.getByLabel('What it is about');
  const kinds = form.getByRole('group', { name: 'Kind of request' });
  const examples: Record<string, string> = {
    Callback: 'e.g. Wants to know if the blood test results are back',
    'Prescription refill': 'e.g. Needs a refill of the heart pill before Friday',
    Voicemail: 'e.g. Left a voicemail asking to move the visit to next week',
    'Follow up': 'e.g. Check how they are feeling after Monday\'s visit',
  };
  for (const [kind, example] of Object.entries(examples)) {
    await kinds.getByRole('button', { name: new RegExp(`^${kind}`) }).click();
    await expect(reason).toHaveAttribute('placeholder', example);
  }
  // a callback, written down as it comes: not urgent, no due day (a callback, so the refill specs after this one still
  // find the assistant's refills first)
  await kinds.getByRole('button', { name: /^Callback/ }).click();
  const words = `Wants a call about the lab results ${Date.now()}`;
  await reason.fill(words);
  await form.getByRole('button', { name: 'Add request' }).click();
  const note = page.getByTestId('toasts').getByText('Request added. It is in the queue for the team.');
  await expect(note).toBeVisible();
  const row = page.getByTestId('task-row').filter({ hasText: words });
  await expect(row).toBeVisible();
  // the note sits clear of the list's right column, where each row's status and buttons are
  const box = (await note.boundingBox())!;
  for (const status of await page.getByTestId('row-status').all()) {
    const s = await status.boundingBox();
    if (s && s.y < box.y + box.height && box.y < s.y + s.height) expect(box.x + box.width, 'the note covers a row\'s status').toBeLessThanOrEqual(s.x);
  }
  // who added it, whole at desktop, tablet and phone widths: wrapped, never cut with an ellipsis
  for (const width of [1380, 820, 400]) {
    await page.setViewportSize({ width, height: 900 });
    const added = row.getByTestId('row-added-by');
    await expect(added).toBeVisible();
    await expect(added).toHaveText(/^Added by .+ \(Practice manager\)$/);
    expect(await added.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis'), `${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 1380, height: 900 });

  // the audit log: added once, under its number, and no "changed its urgency or due day" for it
  const number = (await row.getByTestId('request-number').textContent())!.trim();
  await page.goto(`/c/${clinic}/audit`);
  const rows = page.locator('tbody tr').filter({ hasText: `Request ${number}` });
  await expect(rows.filter({ hasText: 'Took a callback request' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Changed a request\'s urgency or due day' })).toHaveCount(0);
  // every row about one request names it by number, never a bare "Request"
  await expect(page.locator('tbody tr td').filter({ hasText: /^Request$/ })).toHaveCount(0);
});
