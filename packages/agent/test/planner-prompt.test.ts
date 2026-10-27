import { DEMO_CLINIC, RIVERBEND_CLINIC, Texting } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { ResponsesPlanner, stateLine, systemPrompt } from '../src/planner';
import { CallState } from '../src';

describe('the planner\'s instructions follow the clinic\'s industry', () => {
  it('a clinic finds a patient by name, date of birth and phone', () => {
    const prompt = systemPrompt(DEMO_CLINIC, 'Today is Monday.');
    expect(prompt).toContain('verify the patient (name, date of birth and phone)');
    expect(prompt).toContain('Never give medical advice, never interpret symptoms');
  });

  it('never asks for the same detail a third time, and offers a callback instead', () => {
    const prompt = systemPrompt(RIVERBEND_CLINIC, 'Today is Monday.');
    expect(prompt).toContain('Never ask for the same detail a third time');
    expect(prompt).toContain('offer to have the team call them back (create_callback');
  });

  it('a veterinary clinic finds a pet by its owner, its name and the phone, and gives no advice about animals', () => {
    const prompt = systemPrompt(RIVERBEND_CLINIC, 'Today is Monday.');
    expect(prompt).toContain('find the pet (the phone number, which is the household, and the pet\'s name; the owner\'s name never finds a pet)');
    expect(prompt).toContain('Never give medical or first-aid advice for an animal');
    expect(prompt).not.toContain('date of birth and phone)');
  });

  it('never asks which vet or doctor: it searches all and says the name with each time; one question at a time', () => {
    const one = { ...RIVERBEND_CLINIC, providers: RIVERBEND_CLINIC.providers.slice(0, 1) };
    expect(systemPrompt(one, 'now')).toContain('There is only one provider here: never ask the caller which one they would like');
    expect(systemPrompt(RIVERBEND_CLINIC, 'now')).not.toContain('There is only one provider here');
    expect(systemPrompt(RIVERBEND_CLINIC, 'now')).toContain('never ask the caller which vet they would like');
    expect(systemPrompt(DEMO_CLINIC, 'now')).toContain('never ask which doctor they would like');
    expect(systemPrompt(RIVERBEND_CLINIC, 'now')).not.toContain('ask once whether');
    expect(systemPrompt(RIVERBEND_CLINIC, 'now')).toContain('at most one question');
  });

  it('after a miss the state line sends a new caller to register_patient, not the same lookup', () => {
    const state = new CallState();
    expect(stateLine(state)).toContain('patient not verified');
    state.notFound = true;
    expect(stateLine(state)).toContain('if the caller says they are new, call register_patient');
    expect(stateLine(state)).toContain('call verify_caller again with it at once');
  });

  it('after a booking the state line says what is done, so nothing is looked up again', () => {
    const state = new CallState();
    state.done.push('booked Tuesday at 9 with Dr. Ruiz for a sick visit');
    expect(stateLine(state)).toContain('done on this call: booked Tuesday at 9 with Dr. Ruiz for a sick visit (final');
  });

  it('looks the caller up with what they said before asking, reads back as a question, and offers a request before taking it', () => {
    const prompt = systemPrompt(RIVERBEND_CLINIC, 'now');
    expect(prompt).toContain('call verify_caller with exactly what they said before you ask anything else');
    expect(prompt).toContain('never as done ("is set", "is booked")');
    expect(prompt).toContain('offer the request in the same reply; take it after their yes');
    expect(prompt).toContain('do not ask which day, time or provider they would like');
    // a closed day asked for is not the clinic being closed now
    expect(prompt).toContain('offer the first times after it from find_slots, which skips closed days; that is no reason for a callback');
    expect(prompt).toContain('While the clinic is closed right now');
  });

  it('writes in the clinic\'s languages, and searches its own questions in its main one', () => {
    expect(systemPrompt({ ...RIVERBEND_CLINIC, languages: ['en'], primaryLanguage: 'en' }, 'now'))
      .toContain('Write what the assistant says in English, even when the caller speaks another language. Pass questions to get_clinic_info and search_knowledge in English');
    expect(systemPrompt({ ...DEMO_CLINIC, languages: ['en', 'es'], primaryLanguage: 'en' }, 'now'))
      .toContain('in the caller\'s language when it is English or Spanish, otherwise in English');
  });

  it('a veterinary clinic\'s tools take the owner\'s and the pet\'s names', async () => {
    let tools: { name: string; description: string; parameters: { properties: Record<string, unknown> } }[] = [];
    const openai = { responses: { create: async (req: { tools: typeof tools }) => { tools = req.tools; return { output: [], output_text: 'ok' }; } } };
    await new ResponsesPlanner(openai as never, 'test-model').plan({ clinic: RIVERBEND_CLINIC, state: new CallState(), nowLine: 'Today is Monday.' }, async () => ({ ok: true, data: {} }));
    const verify = tools.find((t) => t.name === 'verify_caller')!;
    expect(Object.keys(verify.parameters.properties)).toEqual(['owner_name', 'pet_name', 'phone', 'species']);
    expect(verify.description).toContain('Find the pet');
    expect(Object.keys(tools.find((t) => t.name === 'register_patient')!.parameters.properties)).toContain('species');
  });

  it('offers send_text, and says how texting works, only at a clinic that texts', async () => {
    const texting = { ...DEMO_CLINIC, texting: Texting.parse({ enabled: true }) };
    const toolsFor = async (clinic: typeof DEMO_CLINIC) => {
      let tools: { name: string; strict: boolean }[] = [];
      const openai = { responses: { create: async (req: { tools: typeof tools }) => { tools = req.tools; return { output: [], output_text: 'ok' }; } } };
      await new ResponsesPlanner(openai as never, 'test-model').plan({ clinic, state: new CallState(), nowLine: 'Today is Monday.' }, async () => ({ ok: true, data: {} }));
      return tools;
    };
    expect((await toolsFor(DEMO_CLINIC)).some((t) => t.name === 'send_text')).toBe(false);
    expect((await toolsFor(texting)).find((t) => t.name === 'send_text')).toMatchObject({ strict: true });
    expect(systemPrompt(DEMO_CLINIC, 'Today is Monday.')).not.toContain('Texting:');
    expect(systemPrompt(texting, 'Today is Monday.')).toContain('Texting: after giving the address');
  });
});
