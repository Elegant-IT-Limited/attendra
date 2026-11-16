import { expect, test } from '@playwright/test';
import { signInAgain } from './session';

// Note 2026-11-16 K1: New booking for a pet offered a vet who does not see its kind of animal first. At the vet demo
// clinic Pepper is a rabbit; only Dr. Hana Sato lists rabbits (as "Rabbits"), the other two list dogs and cats. The vet
// list marks the others "(doesn't see rabbits)", from the server's own answer, and "any vet" offers only her times.
test('New booking for a rabbit: only the vet who sees rabbits, the others marked why, as the server says', async ({ browser }) => {
  const page = await signInAgain(browser, 'Vet clinic manager');
  await page.getByRole('link', { name: 'Schedule', exact: true }).first().click();
  await page.getByRole('button', { name: 'New booking' }).click();
  const dialog = page.getByRole('dialog', { name: 'New booking' });
  await dialog.getByLabel('Find a pet').fill('pepper');
  const answer = page.waitForResponse((r) => r.url().includes('/appointments/slots') && r.url().includes('patientId=') && r.url().includes('vt_wellness'));
  await dialog.getByRole('button', { name: /^Pepper Brooks Rabbit/ }).click();
  await dialog.getByLabel('Visit type').selectOption({ label: 'Wellness exam (30 min)' });
  const server = (await (await answer).json()) as { slots: { providerId: string }[]; animal: { kind: string; seeIds: string[] } | null };
  expect(server.animal).toEqual({ kind: 'rabbit', seeIds: ['prov_sato'] });

  const vet = dialog.getByLabel('Veterinarian');
  const options = await vet.locator('option').evaluateAll((os) => os.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent, disabled: (o as HTMLOptionElement).disabled })));
  expect(options).toEqual([
    { value: '', label: 'Any veterinarian', disabled: false },
    { value: 'prov_ruiz', label: 'Dr. Elena Ruiz (doesn\'t see rabbits)', disabled: true },
    { value: 'prov_bell', label: 'Dr. Marcus Bell (doesn\'t see rabbits)', disabled: true },
    { value: 'prov_sato', label: 'Dr. Hana Sato', disabled: false },
  ]);
  // the enabled vets are exactly those the server says see rabbits
  expect(options.filter((o) => o.value && !o.disabled).map((o) => o.value)).toEqual(server.animal!.seeIds);
  // "any vet" offers her times only, and the picker shows those
  expect(server.slots.length).toBeGreaterThan(0);
  expect(new Set(server.slots.map((s) => s.providerId))).toEqual(new Set(['prov_sato']));
  await expect(dialog.getByRole('radio').first()).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Ruiz|Bell/ })).toHaveCount(0);
});
