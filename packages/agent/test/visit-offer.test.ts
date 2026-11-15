// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, PACKS, RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asksWhatVisits, closestVisits, NOT_OFFERED_VISIT, systemPrompt, VISIT_TYPES_RULE, voiceToolDefinitions } from '../src';
import { world } from './support';

// 2026-11-16: a caller who asks for a visit the clinic does not offer (grooming, a boarding stay, laser therapy), or
// asks what they can book. The refusal carries the answer, the same on the planner path and the tools path.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

// books after hours, so the test does not depend on the time of day; no common question about grooming or boarding,
// so the visits are the answer
const clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book', faqs: RIVERBEND_CLINIC.faqs.filter((f) => f.id !== 'faq_boarding') });
const NAMES_EN = ['wellness exam', 'sick visit', 'vaccine appointment', 'new patient exam'];

describe('a visit the clinic does not offer', () => {
  it('is said plainly, with the clinic\'s visits and a request offered, the same words on the planner path and the tools path', async () => {
    const planner = await w.call(null, { clinic, channel: 'web' });
    planner.caller('Can I book laser therapy for my dog?');
    const out = await planner.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_laser_therapy', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(out.errors).toEqual(['unknown_visit_type']);
    const line = PACKS.en.spoken.visitNotOffered({ visits: NAMES_EN });
    expect(line).toBe('That isn\'t something we book here. I can book a wellness exam, a sick visit, a vaccine appointment or a new patient exam. Would you like one of those, or shall I take a request for the team?');
    expect(out.results[0]!.data).toMatchObject({ spoken: line, visit_types: NAMES_EN.map((name, i) => ({ id: clinic.visitTypes[i]!.id, name })) });
    expect(planner.state.pending).toBeNull();
    expect(planner.state.offered.size).toBe(0);
    // what the visit was is never kept to fill the next search
    expect(planner.state.memory.get('visitType')).toBeUndefined();
    // a caller who was answered: the call shows as handled, not abandoned
    expect(planner.state.outcome).toBe('info');

    // the tools path: the voice can only pass the clinic's own ids, or not_offered
    const voice = await w.call(null, { clinic, channel: 'web' });
    voice.caller('Can I book laser therapy for my dog?');
    const tool = (await voice.agent.onToolCall('find_slots', { visit_type_id: NOT_OFFERED_VISIT, provider_id: null, from_date: null, part_of_day: 'any' })).output;
    expect(tool).toMatchObject({ ok: false, outcome: 'unknown_visit_type', spoken: line });
    expect(tool.data.visit_types).toEqual(out.results[0]!.data.visit_types);
    expect(tool.say).toContain('Never look for or book another visit in its place');
  });

  it('is said in Spanish with the visits\' Spanish names', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('Hola, ¿puedo agendar una terapia láser para mi perro?');
    expect(c.state.language).toBe('es');
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: NOT_OFFERED_VISIT, provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(out.errors).toEqual(['unknown_visit_type']);
    expect(out.results[0]!.data.spoken).toBe('Eso no lo agendamos aquí. Puedo agendarle: chequeo general, consulta por enfermedad, cita de vacunas o primera consulta. ¿Quiere una de esas, o prefiere que deje una solicitud para el equipo?');
  });

  it('gives the clinic\'s own common question when one answers it: grooming at a clinic that says it has none', async () => {
    const c = await w.call(null, { clinic: { ...RIVERBEND_CLINIC, afterHours: 'book' }, channel: 'web' });
    c.caller('I want to book a grooming appointment for Biscuit.');
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_grooming', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(out.errors).toEqual(['unknown_visit_type']);
    expect(out.results[0]!.data).toMatchObject({ answer: 'We do not offer boarding or grooming. The front desk can suggest places nearby.', source: 'faq_boarding' });
    // the clinic's words, said in the caller's language by the model: no fixed English line
    expect(out.results[0]!.data.spoken).toBeUndefined();
    expect(c.state.answersGiven.has('faq_boarding')).toBe(true);
  });

  it('never takes a common question that shares only "appointment" or "visit" with what was asked', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('Can I make an appointment for a laser therapy visit?');
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: NOT_OFFERED_VISIT, provider_id: null, from_date: null, part_of_day: 'any' } }]);
    // "What should I bring to the first visit?" shares "visit" only
    expect(out.results[0]!.data.source).toBeUndefined();
    expect(out.results[0]!.data.spoken).toMatch(/^That isn't something we book here\./);
  });

  it('is answered at any hour: a clinic that is closed and takes requests still says it does not book it', async () => {
    const closed = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'requests', faqs: [] });
    const c = await w.call(null, { clinic: closed, channel: 'web' }); // 8 pm, closed
    c.caller('Do you do laser therapy? I want to book it.');
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: NOT_OFFERED_VISIT, provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(out.errors).toEqual(['unknown_visit_type']);
    // and the clinic's own visits still go to the after-hours request, as before
    const own = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(own.errors).toEqual(['after_hours']);
  });
});

describe('the visits offered instead', () => {
  const many = ClinicConfig.parse({
    ...RIVERBEND_CLINIC,
    visitTypes: [
      ...RIVERBEND_CLINIC.visitTypes,
      { id: 'vt_surgery', name: 'surgery', minutes: 60, staffOnly: true },
      { id: 'vt_xray', name: 'x-ray', minutes: 30 },
      { id: 'vt_dental', name: 'dental check-up', names: { es: 'revisión dental' }, minutes: 30, description: 'Teeth and gums looked at, and a cleaning booked if needed.' },
    ],
  });

  it('are up to five, the closest to what was asked first, then the clinic\'s order; never one the team books itself', () => {
    expect(closestVisits(many, 'a dental cleaning for Biscuit', null).map((v) => v.id)).toEqual(['vt_dental', 'vt_wellness', 'vt_sick', 'vt_vaccines', 'vt_new']);
    expect(closestVisits(many, 'laser therapy', null).map((v) => v.id)).toEqual(['vt_wellness', 'vt_sick', 'vt_vaccines', 'vt_new', 'vt_xray']);
    expect(closestVisits(many, 'surgery', null).map((v) => v.id)).not.toContain('vt_surgery');
  });

  it('are only the ones the pet can have once it is found: an existing pet is not offered the new patient exam, a new one not the wellness exam', () => {
    expect(closestVisits(many, 'laser', { isNew: false }).map((v) => v.id)).not.toContain('vt_new');
    expect(closestVisits(many, 'laser', { isNew: true }).map((v) => v.id)).not.toContain('vt_wellness');
  });
});

describe('"what can I book?"', () => {
  it('reads the visits by name, in the caller\'s language, on any path', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('What kinds of appointments do you have?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'What kinds of appointments do you have?' } }]);
    expect(out.results[0]!.data.visits_answer).toBe('We can book a wellness exam, a sick visit, a vaccine appointment and a new patient exam. Which would you like?');
    expect(out.results[0]!.data.say).toMatch(/say visits_answer as written/);

    const es = await w.call(null, { clinic, channel: 'web' });
    es.caller('¿Qué tipo de citas tienen?');
    const tool = (await es.agent.onToolCall('get_clinic_info', { question: 'what kinds of visits' })).output;
    // "visits" is also in "What should I bring to the first visit?": that answer is not about what the clinic books
    expect(tool.data.visits_answer).toBe('Podemos agendarle: chequeo general, consulta por enfermedad, cita de vacunas y primera consulta. ¿Cuál le gustaría?');
  });

  it('leaves the clinic\'s own answer first when it has one, and says nothing of the visits to any other question', async () => {
    const own = ClinicConfig.parse({ ...clinic, faqs: [{ id: 'faq_services', question: 'What services do you offer?', answer: 'We offer wellness exams, vaccinations, dental care and surgery.' }] });
    const c = await w.call(null, { clinic: own, channel: 'web' });
    c.caller('What services do you offer?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'What services do you offer?' } }]);
    expect(out.results[0]!.data).toMatchObject({ source: 'faq_services' });
    expect(out.results[0]!.data.visits_answer).toBeUndefined();

    const hours = await w.call(null, { clinic, channel: 'web' });
    hours.caller('Are you open on Saturday?');
    const asked = await hours.delegate([{ tool: 'get_clinic_info', args: { question: 'open on Saturday' } }]);
    expect(asked.results[0]!.data.visits_answer).toBeUndefined();
  });

  it('is told apart from a caller who describes a problem or names a visit', () => {
    for (const q of ['What kinds of visits do you have?', 'what appointments can I book', 'What can I book for my cat?', 'I\'m not sure which appointment he needs', '¿Qué tipo de citas tienen?', '¿Qué puedo agendar?', 'No sé qué tipo de cita necesita'])
      expect(asksWhatVisits(q), q).toBe(true);
    for (const q of ['My dog is limping, can I bring him in?', 'I need a wellness exam for Biscuit', 'What are your hours?', 'Mi gato está vomitando'])
      expect(asksWhatVisits(q), q).toBe(false);
  });
});

describe('the rule, the same on both paths', () => {
  it('is in the planner\'s instructions (the tools path\'s: voice-engine tests), and find_slots takes not_offered on the tools path', () => {
    expect(systemPrompt(clinic, 'Today is Monday.')).toContain(VISIT_TYPES_RULE);
    const find = voiceToolDefinitions(clinic).find((t) => t.name === 'find_slots')!;
    const visit = (find.parameters as { properties: { visit_type_id: { enum: string[]; description: string } } }).properties.visit_type_id;
    expect(visit.enum).toEqual([...clinic.visitTypes.map((v) => v.id), NOT_OFFERED_VISIT]);
    expect(visit.description).toContain('not_offered when they asked for something that is none of these');
  });
});
