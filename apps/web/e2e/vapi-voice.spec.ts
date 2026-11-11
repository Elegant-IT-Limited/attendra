import { expect, type Page, test } from '@playwright/test';
import { openAs } from './session';

/**
 * A location on Vapi, our backup voice service (note 46). The demo has no Vapi, so the settings the page reads say the
 * location is on it (the server's own answer, with the engine and the Vapi ids changed): Settings > Voice then offers the
 * ElevenLabs voices, Listen asks our API for ElevenLabs' sample, a choice is saved and read back as the server stored
 * it, and the test-call page says how to hear Vapi. Checked at phone, tablet and desktop widths.
 */
const onVapi = (page: Page) => page.route('**/api/v1/clinics/*/settings', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const json = await res.json() as { vapi?: Record<string, unknown> };
  // no voice of its own: the page shows the default, whatever an earlier run saved on the demo server
  const link = { ...json.vapi };
  delete link.voice;
  await route.fulfill({ response: res, json: { ...json, voiceEngine: 'vapi', vapi: { ...link, assistantId: 'asst_e2e', phoneNumberId: 'pn_e2e' } } });
});
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

for (const [label, width, height] of [['phone', 375, 812], ['tablet', 768, 1024], ['desktop', 1280, 900]] as const) {
  test(`a location on Vapi chooses an ElevenLabs voice in Settings, and the test-call page says how to hear Vapi (${label})`, async ({ browser }) => {
    const page = await openAs(browser, 'manager', onVapi);
    await page.setViewportSize({ width, height });
    const clinic = new URL(page.url()).pathname.split('/')[2];
    await page.goto(`/c/${clinic}/settings`);
    const voice = page.locator('#voice');
    await expect(voice).toBeVisible();
    // the default of the clinic's own kind (a woman's voice for marin), never Vapi's own "Elliot"
    await expect(voice.locator('option:checked')).toHaveText("Sarah, a woman's voice, soft and warm");
    await expect(voice.locator('option')).toHaveCount(4);
    await expect(page.getByText('Elliot')).toHaveCount(0);
    await expect(page.getByTestId('vapi-voice-hint')).toContainText('is kept for when it moves back');
    expect(await noSideScroll(page)).toBe(true);

    // Listen asks our API for ElevenLabs' sample, never ElevenLabs itself
    const asked: string[] = [];
    await page.route('**/voice-sample?**', (r) => { asked.push(r.request().url()); return r.fulfill({ status: 422, json: { error: 'no_sample', message: 'This voice could not be played right now.' } }); });
    await voice.selectOption({ label: "Matilda, a woman's voice, warm and friendly" });
    await page.getByRole('button', { name: 'Listen to Matilda' }).click();
    await expect.poll(() => asked.length).toBe(1);
    expect(new URL(asked[0]!).searchParams.get('voice')).toBe('11labs:XrExE9yKIg1WjnnlVkGX');

    // the man's voice has no sample here: said plainly, with no test-call link (a test call never reaches Vapi)
    await voice.selectOption({ label: "Chris, a man's voice, casual and friendly" });
    await expect(page.getByTestId('vapi-no-sample')).toHaveText("No sample: hear it on a call to the location's number.");

    // the choice is saved, and the server's stored voice is what comes back (once: the widths run side by side)
    if (label === 'desktop') {
    await voice.selectOption({ label: "Matilda, a woman's voice, warm and friendly" });
    const saved = page.waitForResponse((r) => r.url().endsWith(`/clinics/${clinic}/settings`) && r.request().method() === 'PUT');
    await page.getByRole('button', { name: /^Save/ }).first().click();
    const body = await (await saved).json() as { vapi?: { voice?: { provider: string; voiceId: string; model: string } } };
    expect(body.vapi?.voice).toEqual({ provider: '11labs', voiceId: 'XrExE9yKIg1WjnnlVkGX', model: 'eleven_flash_v2_5' });
    }

    // the test-call page: a browser test call is Attendra's engine, and the line gives the location's number
    await page.goto(`/c/${clinic}/test-call`);
    await expect(page.getByTestId('vapi-test-call-line')).toHaveText(/^This test call uses Attendra's engine\. To hear Vapi, call \(\d{3}\) \d{3}-\d{4}\.$/);
    expect(await noSideScroll(page)).toBe(true);
    await page.context().close();
  });
}
