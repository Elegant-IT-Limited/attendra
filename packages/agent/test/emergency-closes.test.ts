// SPDX-License-Identifier: AGPL-3.0-only
import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// Call quality Q9 (2026-11-18): a Spanish caller's "está vomitando" began just before the emergency question was said and
// was not taken as the answer; after the demo line the call moved on to the pet's profile, past "Ya está bien, gracias".
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const demo = { ...RIVERBEND_CLINIC, afterHours: 'book' as const, emergencyTransferEnabled: false, demoClinic: { enabled: true, baselineAt: null } };
const said = (out: unknown) => JSON.stringify(out);

describe('a demo clinic\'s emergency', () => {
  it('takes an answer started over the question, then lets the caller go on their thanks', async () => {
    const c = await w.call('+17205550172', { clinic: demo });
    c.caller('Hola, mi perro Biscuit se comió chocolate.');
    // the caller goes on while the question is coming: their words run past the moment it is said
    c.agent.onCallerTranscript('Está vomitando.', 1500, 4000);
    c.agent.onAgentTranscript('Lo siento mucho. ¿Sigue siendo una emergencia ahora mismo? ¿Necesita ayuda para recibir atención de emergencia?', 2000, 3500);
    const routed = c.agent.onAgentTranscript(' ', 3600, 3700);
    void routed;
    // the next caller words make the call look at the answer: the overlap already said yes
    const out = c.caller('Sí.');
    expect(c.state.emergencyCase?.stage).toBe('escalated');
    expect(said(out)).toContain('¿Quiere que deje un mensaje para que el equipo le llame?');
    c.assistant('Esta es una línea de demostración, así que no puedo enviarle a un hospital real. ¿Quiere que deje un mensaje para que el equipo le llame?');
    const done = c.caller('Ya está bien, gracias.');
    expect(said(done)).toContain('Que le vaya bien. ¡Adiós!');
    const end = await c.delegate([{ tool: 'end_call', args: { reason: 'done' } }]);
    expect(end.errors).toEqual([null]);
  });
});

