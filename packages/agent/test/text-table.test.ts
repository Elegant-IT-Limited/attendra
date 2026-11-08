import { ClinicConfig, DEMO_CLINIC, emergencyRoute, type Messenger, PACKS, RIVERBEND_CLINIC, RIVERBEND_HOSPITAL, renderText, TEXT_SITUATIONS, type TextSituation, textRoute, type SmsTemplateName } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOW, world } from './support';

// Batch 1e, item 6: which text goes when is ONE table (core TEXT_TABLE), and send_text reads it. Each row (where the call
// is) is driven through send_text in English and in Spanish: "the address", "the hospital's number", and the opening
// hours, with the text the caller gets rendered in their language. Made-up hospitals and 555-01xx numbers only.
let w: Awaited<ReturnType<typeof world>>;
type Sent = Parameters<Messenger['sendTemplate']>[1];
const sent: Sent[] = [];
beforeAll(async () => {
  w = await world();
  w.backend.messenger = { async sendTemplate(_clinic, m) { sent.push(m); return { status: 'sent', messageId: `sms-${sent.length}` }; } };
});
afterAll(() => w.t.close());

const BACKUP = { name: 'Night Paws Emergency', phone: '+13035550189', address: '9 Night Road, Denver' };
const TEAM = '+13035550177';
// the vet clinic's settings on the test clinic's record, texting on, both languages
const base = ClinicConfig.parse({
  ...RIVERBEND_CLINIC, id: DEMO_CLINIC.id, phoneNumbers: DEMO_CLINIC.phoneNumbers, languages: ['en', 'es'], address: '88 Riverbend Road, Denver',
  texting: { enabled: true }, emergencies: { mode: 'refer', hospital: RIVERBEND_HOSPITAL },
});
const refer = base;
const handleWithBackup = ClinicConfig.parse({ ...base, emergencies: { mode: 'handle', number: TEAM, backupHospital: BACKUP } });
const handleAlone = ClinicConfig.parse({ ...base, emergencies: { mode: 'handle', number: TEAM } });

/** The clinic each row is set at, and how the call got there. */
const ROWS: Record<TextSituation, { clinic: ClinicConfig; set: (s: Awaited<ReturnType<typeof w.call>>['state'], clinic: ClinicConfig) => void }> = {
  calm: { clinic: refer, set: () => {} },
  after_booking: { clinic: refer, set: (s) => { s.outcome = 'booked'; } },
  emergency_question: { clinic: refer, set: (s) => { s.emergencyCase = { stage: 'asked', kind: 'pet_toxin', sign: 'ate chocolate', pet: null, sentAtMs: 0, saidAtMs: 0, signAsked: false, route: null, transfer: 'none' }; } },
  emergency_hospital: { clinic: refer, set: (s, c) => escalated(s, c, 'none') },
  emergency_script: { clinic: refer, set: (s) => { s.emergency = { kind: 'general', atMs: 0 }; } },
  emergency_transfer: { clinic: handleWithBackup, set: (s, c) => escalated(s, c, 'sent') },
  transfer_failed_backup: { clinic: handleWithBackup, set: (s, c) => escalated(s, c, 'failed') },
  transfer_failed: { clinic: handleAlone, set: (s, c) => escalated(s, c, 'failed') },
};
function escalated(s: Awaited<ReturnType<typeof w.call>>['state'], clinic: ClinicConfig, transfer: 'none' | 'sent' | 'failed') {
  s.emergency = { kind: 'pet_toxin', atMs: 0 };
  s.emergencyCase = { stage: 'escalated', kind: 'pet_toxin', sign: 'ate chocolate', pet: null, sentAtMs: 0, saidAtMs: 0, signAsked: false, route: emergencyRoute(clinic, NOW), transfer };
}

const YES = { en: 'Yes, please.', es: 'Sí, por favor.' } as const;
const ASKS = { address: 'directions', hospital: 'emergency_hospital', hours: 'hours' } as const;

/** send_text for one ask, through the offer and a spoken yes when the table sends something: the text, or the refusal. */
async function ask(situation: TextSituation, language: 'en' | 'es', kind: (typeof ASKS)[keyof typeof ASKS]) {
  const row = ROWS[situation];
  const c = await w.call('+13035550147', { clinic: row.clinic });
  c.state.language = language;
  row.set(c.state, row.clinic);
  const before = sent.length;
  const first = await c.delegate([{ tool: 'send_text', args: { kind, ref: null, to: null } }]);
  if (first.errors[0] !== 'consent_required') return { refused: first.errors[0], text: null };
  const offer = /Ask exactly: "([^"]+)"/.exec(String(first.results[0]!.data.say))![1]!;
  expect(offer).toBe(PACKS[language].textOffer({ target: 'this' }));
  c.assistant(offer);
  c.caller(YES[language]);
  const second = await c.delegate([{ tool: 'send_text', args: { kind, ref: null, to: null } }]);
  expect(second.errors).toEqual([null]);
  expect(sent.length).toBe(before + 1);
  const m = sent.at(-1)!;
  expect(m.language).toBe(language);
  return { refused: null, text: { template: m.template, vars: m.vars, body: renderText(m.template as SmsTemplateName, m.vars, language) } };
}

describe('the texts table, row by row, in English and Spanish (batch 1e)', () => {
  it('has a row for every situation and a cell for every ask', () => {
    for (const s of TEXT_SITUATIONS) for (const a of ['address', 'hospital', 'hours', 'provider', 'answer', 'link'] as const) expect(textRoute(s, a)).toBeDefined();
    expect(Object.keys(ROWS).sort()).toEqual([...TEXT_SITUATIONS].sort());
  });

  for (const language of ['en', 'es'] as const) {
    describe(language === 'en' ? 'English' : 'Spanish', () => {
      it('calm, and after a booking: the address is the clinic\'s, with a map link; the hospital\'s text is not for calm times', async () => {
        for (const situation of ['calm', 'after_booking'] as const) {
          const address = await ask(situation, language, ASKS.address);
          expect(address.text).toMatchObject({ template: 'directions', vars: { address: '88 Riverbend Road, Denver' } });
          expect(address.text!.body).toContain('maps.google.com');
          expect((await ask(situation, language, ASKS.hospital)).refused).toBe('not_an_emergency');
          expect((await ask(situation, language, ASKS.hours)).text?.template).toBe('hours');
        }
      });

      it('an emergency asked about and not answered yet: nothing is texted until the one question is answered', async () => {
        for (const kind of Object.values(ASKS)) expect((await ask('emergency_question', language, kind)).refused).toBe('emergency_question');
      });

      it('an emergency sent to a hospital: "the address" and "the hospital\'s number" are the hospital\'s details, never the clinic\'s', async () => {
        for (const kind of [ASKS.address, ASKS.hospital]) {
          const t = await ask('emergency_hospital', language, kind);
          expect(t.text).toMatchObject({ template: 'emergency_hospital', vars: { hospital: RIVERBEND_HOSPITAL.name, hospitalAddress: RIVERBEND_HOSPITAL.address, hospitalPhone: RIVERBEND_HOSPITAL.phone } });
          expect(t.text!.body).toContain(language === 'es' ? 'urgencias veterinarias' : 'emergency vet');
          expect(t.text!.body).not.toContain('88 Riverbend Road');
        }
        expect((await ask('emergency_hospital', language, ASKS.hours)).refused).toBe('emergency_in_progress');
      });

      it('a person in danger, or an immediate script with no route: the hospital it named', async () => {
        const t = await ask('emergency_script', language, ASKS.address);
        expect(t.text).toMatchObject({ template: 'emergency_hospital', vars: { hospital: RIVERBEND_HOSPITAL.name } });
        expect((await ask('emergency_script', language, ASKS.hours)).refused).toBe('emergency_in_progress');
      });

      it('an emergency being put through to the team: nothing is texted while the transfer is on its way', async () => {
        for (const kind of Object.values(ASKS)) expect((await ask('emergency_transfer', language, kind)).refused).toBe('emergency_in_progress');
      });

      it('the transfer failed with a backup hospital: the address and the number are the backup hospital\'s', async () => {
        for (const kind of [ASKS.address, ASKS.hospital]) {
          const t = await ask('transfer_failed_backup', language, kind);
          expect(t.text).toMatchObject({ template: 'emergency_hospital', vars: { hospital: BACKUP.name, hospitalAddress: BACKUP.address, hospitalPhone: BACKUP.phone } });
          expect(t.text!.body).toContain(BACKUP.name);
        }
        expect((await ask('transfer_failed_backup', language, ASKS.hours)).refused).toBe('emergency_in_progress');
      });

      it('the transfer failed with no backup hospital: there is no hospital to text', async () => {
        for (const kind of [ASKS.address, ASKS.hospital]) expect((await ask('transfer_failed', language, kind)).refused).toBe('no_hospital');
        expect((await ask('transfer_failed', language, ASKS.hours)).refused).toBe('emergency_in_progress');
      });
    });
  }

});
