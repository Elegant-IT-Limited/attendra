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
