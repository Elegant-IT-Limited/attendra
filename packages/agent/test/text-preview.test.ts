// SPDX-License-Identifier: AGPL-3.0-only
import { callUsNumber, ClinicConfig, DEMO_CLINIC, emergencyHospitalsOf, emergencyNumberFor, renderText, RIVERBEND_CLINIC, REFER_TO_RIVERBEND_HOSPITAL, type SmsTemplateName, textPreview, type TextRequest } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallState, textContent } from '../src';
import { NOW, world } from './support';

// Texts polish TX1 (2026-11-17): the Settings > Texting preview is the text that goes out. Every text the assistant
// sends on a call (the confirmations after a booking, a move or a cancel, and the texts a caller asks for) is rendered
// as the messenger renders it, and compared with core textPreview of the same facts, given every part Settings offers.
let w: Awaited<ReturnType<typeof world>>;
const sent: { template: SmsTemplateName; vars: Record<string, string>; language: string }[] = [];
beforeAll(async () => {
  w = await world();
  const inner = w.backend.messenger.sendTemplate.bind(w.backend.messenger);
  w.backend.messenger.sendTemplate = async (clinicId: string, m: TextRequest) => { sent.push({ template: m.template as SmsTemplateName, vars: m.vars, language: m.language ?? 'en' }); return inner(clinicId, m); };
});
afterAll(() => w.t.close());

/** Every part Settings > Texting fills in for this kind of clinic, with the facts the sender had over them. */
const settingsParts = (c: ClinicConfig, facts: Record<string, string>) => ({
  clinic: c.name, clinicPhone: callUsNumber(c), emergencyNumber: emergencyNumberFor(c), name: 'Alex', ...(c.industry === 'vet' ? { pet: 'Max', visit: 'check-up' } : {}),
  provider: 'Dr. Lee', when: 'Wednesday', from: 'Tuesday', ref: 'R-12', pharmacy: 'CVS', details: 'sees dogs', answer: 'We are open.', hours: 'Mon-Fri', mapUrl: 'https://maps.example',
  label: 'Form', url: 'https://example.com', address: c.address ?? '1 Main St', hospital: 'City Pet Emergency', hospitalAddress: '1 Oak St', hospitalPhone: '+13035550188', ...facts,
});
const asSent = (s: (typeof sent)[number]) => renderText(s.template, s.vars, s.language as 'en');

describe('the Settings preview is the text the assistant sends (TX1)', () => {
  it('visits: the booking, move and cancel confirmations', async () => {
    const clinic = ClinicConfig.parse({ ...DEMO_CLINIC, texting: { enabled: true } });
    const c = await w.call('+13035550147', { clinic });
    c.caller('Maria Delgado, March 4th 1985. I want to see a doctor.');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    c.readBack('Shall I book it?');
    c.caller('Yes.');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    const [appt] = await w.backend.scheduler.upcoming(DEMO_CLINIC.id, w.patientIds.maria!, new Date('2026-09-28T00:00:00Z'));
    c.caller('Can I move it to a later time?');
    await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()].at(-1)!, replaces_appointment_id: appt!.id }) }]);
    c.readBack('Shall I go ahead?');
    c.caller('Yes please.');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    const [moved] = await w.backend.scheduler.upcoming(DEMO_CLINIC.id, w.patientIds.maria!, new Date('2026-09-28T00:00:00Z'));
    c.caller('Actually, please cancel it.');
    await c.delegate([{ tool: 'propose_cancellation', args: { appointment_id: moved!.id } }]);
    c.readBack('Cancel it?');
    c.caller('Yes, cancel it.');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(sent.map((s) => s.template)).toEqual(['booking_confirmed', 'change_confirmed', 'cancel_confirmed']);
    for (const s of sent) expect(textPreview(s.template, settingsParts(clinic, s.vars), 'en'), s.template).toBe(asSent(s));
  });

  it('during a call: address, hours, emergency hospital, a vet\'s details, an answer and a link', () => {
    const vet = ClinicConfig.parse({ ...RIVERBEND_CLINIC, emergencies: REFER_TO_RIVERBEND_HOSPITAL, texting: { enabled: true, kinds: { provider: true }, links: RIVERBEND_CLINIC.texting!.links } });
    expect(emergencyHospitalsOf(vet.emergencies).length).toBeGreaterThan(0);
    const state = Object.assign(new CallState(), {});
    state.answersGiven.add('faq_address');
    const asks: [Parameters<typeof textContent>[0], string | null][] = [['directions', null], ['hours', null], ['emergency_hospital', null], ['provider', 'prov_ruiz'], ['answer', 'faq_address'], ['link', 'new_client']];
    for (const [kind, ref] of asks) {
      const content = textContent(kind, ref, vet, state, NOW, 'en');
      expect(content, kind).not.toBeNull();
      // as send_text hands it to the messenger: the clinic's name, then the kind's parts
      const s = { template: content!.template as SmsTemplateName, vars: { clinic: vet.name, ...content!.vars }, language: 'en' };
      expect(textPreview(s.template, settingsParts(vet, s.vars), 'en'), kind).toBe(asSent(s));
    }
  });
});
