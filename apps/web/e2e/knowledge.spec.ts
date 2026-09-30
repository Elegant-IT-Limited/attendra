import { expect, test } from '@playwright/test';
import { openAs } from './session';

test('a manager uploads a document, sees it indexed, and asks a question with a cited answer', async ({ browser }) => {
  const page = await openAs(browser, 'manager');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings/knowledge`);
  await expect(page.getByRole('link', { name: 'Knowledge' })).toHaveAttribute('aria-current', 'page');
  // the demo's own documents are there
  await expect(page.getByTestId('knowledge-document').filter({ hasText: 'Parking and directions' })).toContainText('Ready');

  // an empty file is refused, and the page says why
  await page.getByLabel('Title').fill('Nothing here');
  await page.getByLabel('File').setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('The file is empty. Choose one with the text in it.')).toBeVisible();

  await page.getByLabel('Title').fill('Late arrivals');
  await page.getByLabel('File').setInputFiles({
    name: 'late-arrivals.txt', mimeType: 'text/plain',
    buffer: Buffer.from('If you arrive more than 15 minutes late, we may ask you to rebook so the next patient is seen on time. Call us if you are running late.'),
  });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('Uploaded. It is being indexed.')).toBeVisible();
  await expect(page.getByTestId('knowledge-document').filter({ hasText: 'Late arrivals' })).toContainText('Ready', { timeout: 20_000 });

  await page.getByLabel('Question').fill('What happens if I am running late?');
  await page.getByRole('button', { name: 'Ask' }).click();
  const answer = page.getByTestId('knowledge-answer');
  await expect(answer).toContainText('15 minutes late');
  await expect(answer.getByTestId('knowledge-citation').first()).toContainText('Late arrivals');

  // a medical question is refused, whatever the documents say
  await page.getByLabel('Question').fill('How much metformin should I take?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(answer).toContainText("I can't give medical advice");
  await expect(answer.getByTestId('knowledge-citation')).toHaveCount(0);

  // and the new document can be deleted again
  await page.getByRole('button', { name: 'Delete Late arrivals' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('knowledge-document').filter({ hasText: 'Late arrivals' })).toHaveCount(0);
});
