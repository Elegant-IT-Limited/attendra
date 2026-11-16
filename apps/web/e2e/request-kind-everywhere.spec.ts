import { expect, type Page, test } from '@playwright/test';
import { newContext, signInAgain, signInPatiently } from './session';

// Note 2026-11-16 R2b: a request of the clinic's own kind ("Boarding booking") was labelled by its name on Requests and
// in its panel, but Today's "Needs attention" and the read-only (viewer) Requests list still said "Callback", the type it
// is stored as. Each label is checked against the request the server sends. Made-up data on the demo vet clinic.
type Settings = Record<string, unknown> & { requestTopics?: unknown[] };
type Waiting = { tasks: { id: string; number: number; type: string; kind: string | null }[] };
const clinicOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { origin: new URL(page.url()).origin } });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('a request of the clinic\'s own kind is labelled by its name on Today and in the read-only view, as the server says', async ({ browser }) => {
  test.slow(); // two people, and pages next dev compiles on first use
  const page = await signInAgain(browser, 'Vet clinic manager');
  const C = clinicOf(page);
  const original = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
  await call(page, 'PUT', `/clinics/${C}/settings`, { ...original, requestTopics: [{ id: 'topic_board', name: 'Boarding booking', collect: 'The dates' }] });
  let taskId = '';
  let viewerId = '';
  try {
    const made = await call<{ id: string }>(page, 'POST', `/clinics/${C}/tasks`, {
      type: 'callback', topic: 'Boarding booking', name: 'Jo Example', patientId: null, reason: 'Two nights over the long weekend', callbackNumber: null, urgent: false, dueOn: null,
    });
    taskId = made.id;
    // the server's own request, from the home screen's list: its number and its kind
    const served = (await call<Waiting>(page, 'GET', `/clinics/${C}/tasks/waiting`)).tasks.find((t) => t.id === taskId)!;
    expect(served).toMatchObject({ type: 'callback', kind: 'Boarding booking' });
    const label = `R-${served.number} · ${served.kind}`;

    // Today, for the team
    await page.goto(`/c/${C}`);
    const attention = page.getByRole('list', { name: 'Needs attention' });
    await expect(attention.getByText(label, { exact: true })).toBeVisible();
    await expect(attention.getByText(`R-${served.number} · Callback`, { exact: true })).toHaveCount(0);

    // a viewer: the read-only Requests list, the same label, and nothing of what it is about
    const email = `quinn.viewer.${Date.now()}@riverbend-demo.test`;
    const added = await call<{ userId: string; temporaryPassword: string }>(page, 'POST', `/clinics/${C}/members`, { email, role: 'viewer', name: 'Quinn Viewer' });
    viewerId = added.userId;
    const viewer = await (await newContext(browser)).newPage();
    await viewer.goto('/sign-in');
    await viewer.getByLabel('Email').fill(email);
    await viewer.getByLabel('Password').fill(added.temporaryPassword);
    await signInPatiently(viewer, () => viewer.getByRole('button', { name: 'Sign in', exact: true }).click());
    await expect(viewer).toHaveURL(/\/change-password$/, { timeout: 20_000 });
    await viewer.getByLabel('Temporary password').fill(added.temporaryPassword);
    await viewer.getByLabel('New password', { exact: true }).fill('quinn picks a long one');
    await viewer.getByLabel('New password again').fill('quinn picks a long one');
    await viewer.getByRole('button', { name: 'Save my password' }).click();
    await expect(viewer.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    // (a viewer's Today lists no requests, by design: it has no Claim; their read-only list is Requests)
    await viewer.goto(`/c/${C}/requests`);
    const listed = (await call<{ tasks: { id: string; number: number; kind?: string | null; details: Record<string, string> }[] }>(viewer, 'GET', `/clinics/${C}/tasks?status=open`)).tasks.find((t) => t.id === taskId)!;
    expect(listed).toMatchObject({ kind: 'Boarding booking', details: {} });
    const rows = viewer.getByTestId('viewer-requests').getByRole('listitem').filter({ hasText: `R-${listed.number}` });
    await expect(rows).toHaveCount(1);
    await expect(rows.getByTestId('request-kind')).toHaveText(listed.kind!);
    await expect(viewer.getByTestId('viewer-requests')).not.toContainText(/Two nights|Jo Example/);
  } finally {
    // the clinic as it was, for the specs after this one
    if (taskId) await call(page, 'POST', `/clinics/${C}/tasks/${taskId}/claim`).catch(() => {});
    if (taskId) await call(page, 'POST', `/clinics/${C}/tasks/${taskId}/done`, { outcome: 'called_back' }).catch(() => {});
    if (viewerId) await call(page, 'DELETE', `/clinics/${C}/members/${viewerId}`).catch(() => {});
    const now = await call<Settings>(page, 'GET', `/clinics/${C}/settings`);
    await call(page, 'PUT', `/clinics/${C}/settings`, { ...now, requestTopics: original.requestTopics ?? [] });
  }
});
