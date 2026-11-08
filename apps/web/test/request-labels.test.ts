import { ROLES } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { personWithRole, requestCreator, TASK_HISTORY } from '../lib/format';

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
