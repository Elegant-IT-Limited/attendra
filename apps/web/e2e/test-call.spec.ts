import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { E2E_PROVISIONING_TOKEN } from './auth-state';
import { openAs } from './session';

// Never places a real call: the test-call request is answered here, whatever server runs.
test('front desk is told plainly when test calls are not set up', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk', (p) => p.route('**/api/v1/clinics/*/test-calls', (r) => r.fulfill({ status: 503, json: { error: 'voice_not_configured' } })));
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/test-call`);
  const start = page.getByRole('button', { name: 'Start test call' });
  // the demo without a key turns the page off; one with a key shows the button
  await expect(start.or(page.getByText('Test calls are off'))).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(page.getByText('Test calls are not set up on this server.')).toBeVisible();
  // a link to the guide, not a path in the repository to go and find
  await expect(page.getByText('docs/test-calls.md', { exact: false })).toHaveCount(0);
  if (!(await start.isVisible())) {
    await expect(page.getByRole('link', { name: 'How to set up test calls' })).toHaveAttribute('href', 'https://github.com/Elegant-IT-Limited/attendra/blob/main/docs/test-calls.md');
  }
});

// A simulated call: scripted, on the demo server, held by the clinic's frame like a browser test call.
test('a test call keeps going from Test call to Calls and back, with the call bar on every page', async ({ browser }) => {
  test.slow();
  const page = await openAs(browser, 'frontdesk');
  const clinic = new URL(page.url()).pathname.split('/')[2];
  const live = async () => ((await (await page.request.get(`/api/v1/clinics/${clinic}/live`)).json()) as { calls: { callId: string }[] }).calls.map((c) => c.callId);
  await page.goto(`/c/${clinic}/test-call`);
  await page.getByRole('button', { name: 'Play a simulated call' }).click();
  await expect(page).toHaveURL(/\/calls\/[^/]+\/live$/, { timeout: 20_000 });
  const callId = new URL(page.url()).pathname.split('/')[4]!;
  const bar = page.getByRole('region', { name: 'Test call in progress' });
  await expect(bar).toContainText('Simulated call');

  // to Calls through the menu: the call goes on, and the bar shows there with its clock running
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calls', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/calls$`));
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('call-bar-status')).toHaveText(/^\d+:\d{2}$/);
  await expect(bar.getByTestId('call-bar-status')).not.toHaveText('0:00', { timeout: 5_000 });
  expect(await live()).toContain(callId);

  // and back to Test call from the bar: still the same call
  await bar.getByRole('link', { name: 'Back to Test call' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/test-call$`));
  await expect(bar).toBeVisible();
  expect(await live()).toContain(callId);

  // hang up from the bar: the bar goes, and so does the call
  await bar.getByRole('button', { name: 'Hang up' }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(live, { timeout: 30_000 }).not.toContain(callId);
});

// The record tick: ticked and kept by the clinic's frame while nothing is recording (a simulated call has no audio).
test('"Record this test call" can be ticked, and stays ticked from page to page until a call records', async ({ browser }) => {
  // the demo has no voice key: the page is told test calls are on, so it shows its own controls; no call is placed
  const page = await openAs(browser, 'frontdesk', (p) => p.route('**/api/v1/me', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), testCalls: true } });
  }));
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/test-call`);
  const tick = page.getByRole('checkbox', { name: 'Record this test call' });
  await expect(tick).toBeVisible();
  await expect(tick).not.toBeChecked();
  await expect(page.getByText('Saved to your Downloads when the call ends, on this computer only. Nothing is uploaded.')).toBeVisible();
  await tick.click();
  await expect(tick).toBeChecked();
  // nothing records until a call is live
  await expect(page.getByTestId('recording-on')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Save the recording' })).toHaveCount(0);
  // the tick lives with the call, in the clinic's frame: still set after a visit to Calls
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calls', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/calls$`));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Test call', exact: true }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Record this test call' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Record this test call' }).click();
  await expect(page.getByRole('checkbox', { name: 'Record this test call' })).not.toBeChecked();
});

/** The page is told test calls are on (the demo has no voice key); nothing else about /me changes. */
const testCallsOn = (p: Page) => p.route('**/api/v1/me', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ response: res, json: { ...(await res.json()), testCalls: true } });
});
type Allowance = { limitSeconds: number | null; usedSeconds: number; perCallSeconds: number | null; callSeconds: number | null };
/** Opens Test call and hands back the allowance the page itself read from the API. */
async function openTestCall(page: Page, clinic: string) {
  const answer = page.waitForResponse((r) => r.url().endsWith(`/clinics/${clinic}/test-calls/allowance`) && r.request().method() === 'GET');
  await page.goto(`/c/${clinic}/test-call`);
  return (await (await answer).json()) as Allowance;
}

// The limit before a call is the server's: the voice service's limit for one call, or the clinic's time left when that is less.
test('before a call, the page says the limit the API gives: one call\'s, or the time left when that is less', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk', testCallsOn);
  const clinic = new URL(page.url()).pathname.split('/')[2]!;
  const label = page.getByTestId('test-call-limit');

  // no limit for the clinic: one call's limit, from the voice service's config
  const open = await openTestCall(page, clinic);
  expect(open.limitSeconds).toBeNull();
  expect(open.perCallSeconds).toEqual(expect.any(Number));
  expect(open.callSeconds).toBe(open.perCallSeconds);
  await expect(label).toHaveText(`One test call can last up to ${Math.floor(open.callSeconds! / 60)} minutes`);

  // a trial with less left than one call: the time left
  const limit = (seconds: number | null) => page.request.put(`/api/v1/provisioning/clinics/${clinic}/test-call-limit`, { headers: { authorization: `Bearer ${E2E_PROVISIONING_TOKEN}` }, data: { seconds } });
  expect((await limit(open.usedSeconds + Math.floor(open.perCallSeconds! / 2))).status()).toBe(204);
  try {
    const small = await openTestCall(page, clinic);
    expect(small.callSeconds).toBe(small.limitSeconds! - small.usedSeconds);
    expect(small.callSeconds!).toBeLessThan(small.perCallSeconds!);
    // shown text equals the server's number, in the one format (lib/test-call-limit testTimeLeft): "Test calls: 7 min 30 s left"
    const m = Math.floor(small.callSeconds! / 60);
    const r = small.callSeconds! % 60;
    await expect(label).toHaveText(`Test calls: ${[m ? `${m} min` : '', r || !m ? `${r} s` : ''].filter(Boolean).join(' ')} left`);
    await expect(page.getByText(/\d+:\d\d of test calls left/)).toHaveCount(0);
  } finally {
    expect((await limit(null)).status()).toBe(204);
  }
});

/**
 * A browser test call with no OpenAI and no audio from anywhere: the peer connection and MediaRecorder are
 * stand-ins (the recorder's deps come from the window), the start is answered here, and the microphone is a
 * silent stream from WebAudio (no device and no permission, on any machine). The recording is a few known bytes, so a request that carried it would show.
 */
const RECORDING = 'FAKE-RECORDING-BYTES-5550142';
async function fakeBrowserCall(page: Page, maxSeconds: number, engine: 'gpt-live' | 'realtime' = 'gpt-live') {
  await page.addInitScript(([bytes, kind]) => {
    const seen = window as unknown as { __sent: string[]; __peerClosed: boolean };
    seen.__sent = [];
    seen.__peerClosed = false;
    class FakeRecorder {
      static isTypeSupported(t: string) { return t === 'audio/webm;codecs=opus'; }
      state: RecordingState = 'inactive';
      mimeType: string;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) { this.mimeType = options?.mimeType ?? ''; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([bytes]) }); setTimeout(() => this.onstop?.(), 0); }
    }
    class FakePeer {
      iceGatheringState = 'complete';
      connectionState = 'new';
      localDescription: RTCSessionDescriptionInit | null = null;
      ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      private stream: MediaStream | null = null;
      private channel: { readyState: string; onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((m: { data: string }) => void) | null; send: (data: string) => void; close: () => void } | null = null;
      addEventListener() {}
      addTrack(_t: MediaStreamTrack, s: MediaStream) { this.stream = s; }
      createDataChannel() {
        const ch = { readyState: 'connecting', onopen: null as (() => void) | null, onclose: null as (() => void) | null, onmessage: null as ((m: { data: string }) => void) | null,
          send(data: string) { seen.__sent.push(String(data)); },
          close() { if (ch.readyState === 'closed') return; ch.readyState = 'closed'; setTimeout(() => ch.onclose?.(), 0); } };
        this.channel = ch;
        return ch;
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
      async setLocalDescription(d: RTCSessionDescriptionInit) { this.localDescription = d; }
      // the assistant's audio is the stand-in microphone played back: enough for the recorder's mix
      async setRemoteDescription() {
        setTimeout(() => {
          this.ontrack?.({ streams: [this.stream!] }); this.channel!.readyState = 'open'; this.channel!.onopen?.();
          // OpenAI's first event on the data channel: GPT-Live says session.started, Realtime session.created
          this.channel!.onmessage?.({ data: JSON.stringify({ type: kind === 'realtime' ? 'session.created' : 'session.started' }) });
        }, 50);
      }
      close() { seen.__peerClosed = true; this.channel?.close(); }
    }
    Object.assign(window, { MediaRecorder: FakeRecorder, RTCPeerConnection: FakePeer });
    navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
  }, [RECORDING, engine] as const);
  await page.route('**/api/v1/clinics/*/test-calls', (r) => r.fulfill({ status: 201, json: { callId: 'call_fake_recording', sdp: 'v=0 answer', maxSeconds } }));
  await page.route('**/api/v1/clinics/*/test-calls/*/end', (r) => r.fulfill({ status: 202, json: { ending: true } }));
}

test('End on a Realtime call asks our API to end it while the line is open, then closes the line, and never sends session.close', async ({ browser }) => {
  test.slow();
  const page = await openAs(browser, 'frontdesk', async (p) => { await testCallsOn(p); await fakeBrowserCall(p, 600, 'realtime'); });
  const clinic = new URL(page.url()).pathname.split('/')[2]!;
  // the end request is answered a moment later; the line must still be open when it is asked (2026-11-11: the page closed
  // the line first, and our hang-up found no session)
  const ends: boolean[] = [];
  await page.unroute('**/api/v1/clinics/*/test-calls/*/end');
  await page.route('**/api/v1/clinics/*/test-calls/*/end', async (r) => {
    ends.push(await page.evaluate(() => (window as unknown as { __peerClosed: boolean }).__peerClosed));
    await new Promise((done) => setTimeout(done, 300));
    await r.fulfill({ status: 202, json: { ending: true } });
  });
  await openTestCall(page, clinic);
  await page.getByRole('button', { name: 'Start test call' }).click();
  await page.getByRole('button', { name: 'End call' }).click();
  await expect(page.getByRole('button', { name: 'Start test call' })).toBeVisible();
  // one end request, made while the line was open; the line closed after it; no session.close on a Realtime call
  expect(ends).toEqual([false]);
  expect(await page.evaluate(() => (window as unknown as { __peerClosed: boolean }).__peerClosed)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent.filter((m) => m.includes('session.close')))).toEqual([]);
});

test('the recording saves itself to Downloads when the call ends, asks before a reload while recording, and is never uploaded', async ({ browser }) => {
  test.slow();
  const page = await openAs(browser, 'frontdesk', async (p) => { await testCallsOn(p); await fakeBrowserCall(p, 600); });
  const clinic = new URL(page.url()).pathname.split('/')[2]!;
  const carried: string[] = [];
  page.on('request', (r) => { if ((r.postData() ?? '').includes(RECORDING)) carried.push(r.url()); });
  await openTestCall(page, clinic);
  await page.getByRole('checkbox', { name: 'Record this test call' }).click();
  await page.getByRole('button', { name: 'Start test call' }).click();
  await expect(page.getByTestId('recording-on')).toBeVisible();

  // a reload while recording: the browser asks first; staying keeps the call and its recording
  const asked = page.waitForEvent('dialog');
  void page.reload().catch(() => {}); // cancelled by the dialog
  const dialog = await asked;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await expect(page.getByTestId('recording-on')).toBeVisible();

  // signing out asks too; staying keeps the call
  // (confirm() holds the click until the dialog is answered, so it is answered from the listener)
  let leave: string[] = [];
  page.once('dialog', (d) => { leave = [d.type(), d.message()]; void d.dismiss(); });
  await page.getByRole('button', { name: /account and theme/ }).first().click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect.poll(() => leave).toEqual(['confirm', 'The test call recording is not saved yet. Leave anyway and lose it?']);
  await expect(page).toHaveURL(new RegExp(`/c/${clinic}/test-call$`));
  await expect(page.getByTestId('recording-on')).toBeVisible();

  // the call ends: the file is saved, under the name the call started with
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'End call' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^attendra-test-call-\d{4}-\d{2}-\d{2}-\d{4}\.webm$/);
  // the file is the recording itself, made in this browser
  expect(readFileSync((await file.path())!).toString()).toBe(RECORDING);
  const saved = page.getByTestId('recording-saved');
  await expect(saved).toContainText(`Saved to your Downloads: ${file.suggestedFilename()}`);

  // "Save again": the same file, the same name
  const again = page.waitForEvent('download');
  await saved.getByRole('button', { name: 'Save again' }).click();
  expect((await again).suggestedFilename()).toBe(file.suggestedFilename());

  // saved, so a reload no longer asks; and no request ever carried the recording
  let askedAgain = false;
  page.on('dialog', (d) => { askedAgain = true; void d.dismiss(); });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start test call' })).toBeVisible();
  expect(askedAgain).toBe(false);
  expect(carried).toEqual([]);
});

test('a recording still going when the clinic\'s pages are left without a question (the browser\'s Back, a link out) saves itself', async ({ browser }) => {
  test.slow();
  const page = await openAs(browser, 'frontdesk', async (p) => { await testCallsOn(p); await fakeBrowserCall(p, 600); });
  const clinic = new URL(page.url()).pathname.split('/')[2]!;
  await openTestCall(page, clinic);
  await page.getByRole('checkbox', { name: 'Record this test call' }).click();
  await page.getByRole('button', { name: 'Start test call' }).click();
  await expect(page.getByTestId('recording-on')).toBeVisible();
  // a move inside the app to a page outside the clinic's frame: no reload, so no browser question
  const download = page.waitForEvent('download');
  await page.evaluate(() => (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router.push('/profile'));
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^attendra-test-call-\d{4}-\d{2}-\d{2}-\d{4}\.webm$/);
  expect(readFileSync((await file.path())!).toString()).toBe(RECORDING);
  await expect(page).toHaveURL(/\/profile$/);
});

// "Call as": the picker reads the demo's made-up records through the real API; the start request is answered here, so no call is placed.
test('"Call as" offers numbers from the records by first name and last four digits, takes typed numbers only, and starts the call with the choice', async ({ browser }) => {
  const starts: { callAs?: unknown }[] = [];
  const page = await openAs(browser, 'frontdesk', async (p) => {
    // a silent microphone made in the page: no device or permission prompt is needed for a call that is never placed
    await p.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
    });
    await p.route('**/api/v1/me', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), testCalls: true } });
    });
    await p.route('**/api/v1/clinics/*/test-calls', async (route) => {
      starts.push(route.request().postDataJSON() as { callAs?: unknown });
      await route.fulfill({ status: 503, json: { error: 'voice_not_configured' } });
    });
  });
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/test-call`);
  const callAs = page.getByLabel('Call as', { exact: true });
  await expect(callAs).toHaveValue('none');
  await expect(page.getByText('The assistant asks for a number when it needs one.')).toBeVisible();

  // from the records: one row per household, the owner's first name and the last four digits, never the whole number
  await callAs.selectOption({ label: 'A number from your records' });
  const list = page.getByRole('listbox', { name: 'Numbers from your records' });
  // before anything is typed, the newest records
  await expect(list.getByRole('option').first()).toHaveText(/^\p{L}+ · …\d{4}$/u);
  await expect(list).not.toContainText('555');
  const start = page.getByRole('button', { name: 'Start test call' });
  await expect(start).toBeDisabled(); // nothing picked yet
  const find = page.getByPlaceholder('Owner name or last digits');
  // Maria and her two children share one number: one row, under her name
  await find.fill('Delgado');
  await expect(list.getByRole('option')).toHaveText(['Maria · …0147']);
  await find.fill('0147');
  await expect(list.getByRole('option')).toHaveText(['Maria · …0147']);
  await find.fill('whit');
  await expect(list.getByRole('option')).toHaveText(['James · …0163']);
  await list.getByRole('option', { name: 'James · …0163' }).click();
  await expect(list.getByRole('option', { name: 'James · …0163' })).toHaveAttribute('aria-selected', 'true');
  await start.click();
  await expect(page.getByText('Test calls are not set up on this server.')).toBeVisible();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]!.callAs).toEqual({ kind: 'record', patientId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  await page.keyboard.press('Escape');

  // typed: letters are dropped as they come, with a note, and the number goes as typed (the server reads it)
  await callAs.selectOption({ label: 'Type a number' });
  const number = page.getByLabel('Number to call as');
  await number.pressSequentially('303-555-O1');
  await expect(page.getByText('Use numbers only, for example (555) 555-0123.')).toBeVisible();
  await expect(number).toHaveValue('303-555-1');
  await number.fill('');
  await number.pressSequentially('303-555-0142');
  await start.click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]!.callAs).toEqual({ kind: 'typed', number: '303-555-0142' });
  await page.keyboard.press('Escape');

  // no caller ID: today's call, nothing sent
  await callAs.selectOption({ label: 'No caller ID' });
  await start.click();
  await expect.poll(() => starts.length).toBe(3);
  expect(starts[2]!.callAs).toEqual({ kind: 'none' });
});

// The badge: the last four digits are the server's (here a call the list is told was started as …0123).
test('a browser test call started as a number says so on the calls list and the call\'s page', async ({ browser }) => {
  const page = await openAs(browser, 'frontdesk', async (p) => {
    await p.route(/\/api\/v1\/clinics\/[^/]+\/calls(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      const body = await res.json() as { calls: { id: string; channel: string; calledAsLast4: string | null }[] };
      body.calls[0] = { ...body.calls[0]!, channel: 'web', calledAsLast4: '0123' };
      await route.fulfill({ response: res, json: body });
    });
    await p.route(/\/api\/v1\/clinics\/[^/]+\/calls\/[0-9a-f-]{36}$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), channel: 'web', calledAsLast4: '0123' } });
    });
  });
  const clinic = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/c/${clinic}/calls`);
  await expect(page.getByText('Browser test, called as …ending 0123').first()).toBeVisible();
  const calls = ((await (await page.request.get(`/api/v1/clinics/${clinic}/calls`)).json()) as { calls: { id: string }[] }).calls;
  await page.goto(`/c/${clinic}/calls/${calls[0]!.id}`);
  await expect(page.getByText('Browser test, called as …ending 0123')).toBeVisible();
});
