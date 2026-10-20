import { DEMO_CLINIC, RIVERBEND_CLINIC, Texting } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { ResponsesPlanner, systemPrompt } from '../src/planner';
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
    expect(prompt).toContain('find the pet (the owner\'s full name, the pet\'s name and the phone on file)');
    expect(prompt).toContain('Never give medical or first-aid advice for an animal');
    expect(prompt).not.toContain('date of birth and phone)');
  });

  it('a clinic with one vet never asks which vet; one with several asks once, and asks one question at a time', () => {
    const one = { ...RIVERBEND_CLINIC, providers: RIVERBEND_CLINIC.providers.slice(0, 1) };
    expect(systemPrompt(one, 'now')).toContain('There is only one provider here: never ask the caller which one they would like');
    expect(systemPrompt(RIVERBEND_CLINIC, 'now')).not.toContain('There is only one provider here');
    expect(systemPrompt(RIVERBEND_CLINIC, 'now')).toContain('at most one question');
  });

  it('a veterinary clinic\'s tools take the owner\'s and the pet\'s names', async () => {
    let tools: { name: string; description: string; parameters: { properties: Record<string, unknown> } }[] = [];
    const openai = { responses: { create: async (req: { tools: typeof tools }) => { tools = req.tools; return { output: [], output_text: 'ok' }; } } };
    await new ResponsesPlanner(openai as never, 'test-model').plan({ clinic: RIVERBEND_CLINIC, state: new CallState(), nowLine: 'Today is Monday.' }, async () => ({ ok: true, data: {} }));
    const verify = tools.find((t) => t.name === 'verify_caller')!;
    expect(Object.keys(verify.parameters.properties)).toEqual(['owner_name', 'pet_name', 'phone']);
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
