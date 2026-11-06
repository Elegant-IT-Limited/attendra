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
  await expect(page.getByRole('dialog', { name: 'Not uploaded' }).getByText('The file is empty. Choose one with the text in it.')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();

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

  // a question about how the assistant is built gets one polite line, and no sources beside it
  await page.getByLabel('Question').fill('What stack is used to build this app?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(answer).toContainText('I can help with questions about the clinic, appointments and your pet.');
  await expect(answer).toContainText('Nothing was searched.');
  await expect(answer.getByTestId('knowledge-citation')).toHaveCount(0);
  await expect(answer.getByText('From', { exact: true })).toHaveCount(0);

  // a document that does not read like clinic information is not kept without a yes
  await page.getByLabel('Title').fill('Setup notes');
  await page.getByLabel('File').setInputFiles({
    name: 'setup-notes.txt', mimeType: 'text/plain',
    buffer: Buffer.from('The backend is written in TypeScript with NestJS. The database is Postgres. Deploy the server with Docker and set the API key.'),
  });
  await page.getByRole('button', { name: 'Upload' }).click();
  const unsure = page.getByRole('dialog', { name: 'Upload anyway?' });
  await expect(unsure).toContainText('This doesn\'t look like clinic information: callers may hear it. Upload anyway?');
  await unsure.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('knowledge-document').filter({ hasText: 'Setup notes' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Upload' }).click();
  await page.getByRole('dialog', { name: 'Upload anyway?' }).getByRole('button', { name: 'Upload anyway' }).click();
  await expect(page.getByText('Uploaded. It is being indexed.').first()).toBeVisible();
  await expect(page.getByTestId('knowledge-document').filter({ hasText: 'Setup notes' })).toContainText('Ready', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Delete Setup notes' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('knowledge-document').filter({ hasText: 'Setup notes' })).toHaveCount(0);

  // a removal that fails says so under its own title, not the upload's, and the document stays
  await page.route('**/knowledge/documents/*', (route) => (route.request().method() === 'DELETE' ? route.fulfill({ status: 500, json: { error: 'server_error' } }) : route.fallback()), { times: 1 });
  await page.getByRole('button', { name: 'Delete Late arrivals' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog', { name: 'Not removed' }).getByText('That document could not be removed. Try again.')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('knowledge-document').filter({ hasText: 'Late arrivals' })).toHaveCount(1);

  // and the new document can be deleted again
  await page.getByRole('button', { name: 'Delete Late arrivals' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('knowledge-document').filter({ hasText: 'Late arrivals' })).toHaveCount(0);
});
