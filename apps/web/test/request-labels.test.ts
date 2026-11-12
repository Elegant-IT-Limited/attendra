import { ROLES } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { personWithRole, requestCreator, requestExample, TASK_HISTORY, TASK_KIND_ORDER } from '../lib/format';

// REQ-1 and REQ-3 (batch 4b): who added a request, with their role, and the words of its history.
describe('who added a request', () => {
  it('names a teammate with their role here, the assistant for a call\'s request, and a former teammate without either', () => {
    expect(requestCreator({ callId: null, createdBy: { name: 'Jordan Lee', role: 'staff' } })).toBe('Jordan Lee (Front desk)');
    expect(requestCreator({ callId: 'call-1', createdBy: null })).toBe('the assistant');
    expect(requestCreator({ callId: null, createdBy: { name: null, role: null } })).toBe('a former team member');
    expect(requestCreator({ callId: null, createdBy: null })).toBe('the team');
  });

  it('says every role in the words of the roles table', () => {
    for (const r of ROLES) expect(personWithRole('Jordan Lee', r.id)).toBe(`Jordan Lee (${r.label})`);
  });
});

describe('a request\'s history', () => {
  it('has words for every change a request records, reopening included, and never for a view', () => {
    for (const action of ['task.created.callback', 'task.claimed', 'task.assigned', 'task.planned', 'task.note.added', 'task.done', 'task.done.refill_sent', 'task.reopened']) {
      expect(TASK_HISTORY[action], action).toMatch(/^[A-Z]/);
    }
    expect(TASK_HISTORY['task.reopened']).toBe('Reopened a request');
    expect(TASK_HISTORY['task.viewed']).toBeUndefined();
  });
});

// note 52 C8: "What it is about" showed a dental cleaning as the example for a prescription refill
describe('the example under "What it is about" in New request', () => {
  it('is one for each kind of request, a refill reads as a refill, and the clinic\'s own kinds get a general one', () => {
    expect(requestExample('refill', true)).toBe('e.g. Needs a refill of the heart pill before Friday');
    expect(requestExample('refill', false)).toBe('e.g. Needs a refill of the heart pill before Friday');
    const kinds = TASK_KIND_ORDER.filter((k) => k !== 'review'); // a new pet or patient to check is the assistant's own
    for (const pets of [true, false]) {
      const examples = kinds.map((k) => requestExample(k, pets));
      expect(new Set(examples).size, String(pets)).toBe(kinds.length);
      for (const e of examples) expect(e).toMatch(/^e\.g\. [A-Z].{10,}[^.]$/);
    }
    expect(requestExample('topic:Boarding', true)).toBe('e.g. Wants a dental cleaning for Bella next month');
    expect(requestExample('topic:Billing', false)).toBe('e.g. Wants a check-up next month');
    // a human clinic's examples name no pet
    for (const k of kinds) expect(requestExample(k, false)).not.toContain('Bella');
  });
});
