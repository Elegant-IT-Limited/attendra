import { expect, test } from '@playwright/test';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAs } from './session';

/** What a receiver does with a delivery, as docs/webhooks.md shows it. */
function verified(secret: string, headers: IncomingHttpHeaders, body: string) {
  const signed = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`;
  const expected = Buffer.from(`v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(signed).digest('base64')}`);
  return String(headers['webhook-signature']).split(' ').some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
}

// The demo server runs with ATTENDRA_WEBHOOKS_ALLOW_LOCAL=on, so it may deliver to this test's receiver on 127.0.0.1.
test('a manager adds an endpoint, sends a signed test event to a receiver, and redelivers it from the log', async ({ browser }) => {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const receiver = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); }); });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/n8n`;
  try {
    const page = await openAs(browser, 'manager');
    const clinic = new URL(page.url()).pathname.split('/')[2];
    await page.goto(`/c/${clinic}/settings/integrations`);
    await page.getByLabel('URL').fill('https://10.0.0.5/hook');
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await expect(page.getByText('That address is on a private network or this server. Use a public https address.')).toBeVisible();

    await page.getByLabel('URL').fill(url);
    await page.getByLabel('Description').fill('n8n on this machine');
    await page.getByRole('checkbox', { name: /A request was closed/ }).click();
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    const secret = (await page.getByTestId('webhook-secret').textContent())!;
    expect(secret).toMatch(/^whsec_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('webhook-secret')).toHaveCount(0);

    const endpoint = page.getByTestId('webhook-endpoint').filter({ hasText: url });
    await endpoint.getByRole('button', { name: 'Send test event' }).click();
    await expect(page.getByText(/Test event delivered: 200 in \d+ ms/)).toBeVisible();
    expect(received).toHaveLength(1);
    expect(verified(secret, received[0]!.headers, received[0]!.body)).toBe(true);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: 'webhook.test', data: { clinicId: clinic, test: true } });

    const attempt = endpoint.getByTestId('webhook-attempt').first();
    await expect(attempt).toContainText('webhook.test');
    await expect(attempt).toContainText('200 in');
    await attempt.getByRole('button', { name: 'Redeliver' }).click();
    await expect(page.getByText(/Redelivered: 200 in \d+ ms/)).toBeVisible();
    expect(received).toHaveLength(2);
    expect(received[1]!.headers['webhook-id']).toBe(received[0]!.headers['webhook-id']);
    await expect(endpoint.getByTestId('webhook-attempt')).toHaveCount(2);

    // a redelivery the server refuses says so, instead of nothing
    await page.route((u) => u.pathname.endsWith('/redeliver'), (route) => route.fulfill({ status: 500, json: { error: 'internal' } }));
    await endpoint.getByTestId('webhook-attempt').first().getByRole('button', { name: 'Redeliver' }).click();
    await expect(page.getByText('The redelivery did not go out. Try again.')).toBeVisible();
    await page.unrouteAll();
  } finally {
    receiver.close();
  }
});

test('the front desk has no Integrations page', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/settings`);
  await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Integrations' })).toHaveCount(0);
  await page.goto(`/c/${clinic}/settings/integrations`);
  await expect(page.getByText('Only owners and practice managers manage integrations.')).toBeVisible();
});
