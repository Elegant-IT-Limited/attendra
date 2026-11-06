import { DEMO_CLINIC } from '@attendra/core';
import { KnowledgeRepository } from '@attendra/db';
import { HybridKnowledgeBase, indexDocument, LocalAnswerer, LocalEmbedder } from '@attendra/knowledge';
import type { DocumentJob } from '@attendra/worker/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, ORIGIN, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'admin' | 'staff' | 'viewer' | 'outsider', string>;
const queued: DocumentJob[] = [];
const embedder = new LocalEmbedder();

const upload = (cookie: string, title: string, body: Buffer | string, type = 'text/plain', name = 'doc.txt', confirm = false) => api.app.getHttpAdapter().getInstance().inject({
  method: 'POST', url: `${C}/knowledge/documents?${new URLSearchParams({ title, name, ...(confirm ? { confirm: 'true' } : {}) })}`, headers: { cookie, origin: ORIGIN, 'content-type': type }, payload: body,
});

beforeAll(async () => {
  api = await startApi({
    demoMode: false,
    // the worker's job, run straight away
    jobs: { callCompleted: async () => {}, webhookEvent: async () => {}, requestReady: async () => {}, smsStatus: async () => {}, indexDocument: async (j) => { queued.push(j); await indexDocument(new KnowledgeRepository(api.t.db), embedder, j.clinicId, j.documentId); } },
    // the database exists once the API has started, and searches only happen after that
    knowledge: { base: { search: (clinicId, q) => new HybridKnowledgeBase(new KnowledgeRepository(api.t.db), embedder).search(clinicId, q) }, answerer: new LocalAnswerer() },
  });
  as = {
    admin: await api.signIn('olga@maple.example', true), staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true), outsider: await api.signIn('otto@other.example', true),
  };
});
afterAll(() => api.close());

describe('the clinic\'s knowledge', () => {
  it('a manager uploads a document; it is indexed once and listed with its chunks', async () => {
    const res = await upload(as.admin, 'Late arrivals', 'If you arrive more than 15 minutes late, we may ask you to rebook so the next patient is seen on time.');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: 'Late arrivals', sourceType: 'text', uploadedBy: 'Olga Admin' });
    expect(queued).toHaveLength(1);
    await upload(as.admin, 'Late arrivals', 'If you arrive more than 15 minutes late, we may ask you to rebook so the next patient is seen on time.');
    expect(queued).toHaveLength(1); // the same bytes again: nothing to index
    const list = (await api.request('GET', `${C}/knowledge/documents`, { cookie: as.staff })).json();
    expect(list.documents).toEqual([expect.objectContaining({ title: 'Late arrivals', status: 'ready', chunkCount: 1 })]);
    expect((await api.t.db.execute(sql`select action from audit_logs where action = 'knowledge.document.uploaded'`)).rows).toHaveLength(1);
  });

  it('refuses a file type it cannot read, one over 5 MB, and an empty one', async () => {
    expect((await upload(as.admin, 'Scan', Buffer.from([1, 2, 3]), 'application/octet-stream', 'scan.docx')).statusCode).toBe(415);
    expect((await upload(as.admin, 'Huge', Buffer.alloc(5 * 1024 * 1024 + 1, 97))).statusCode).toBe(413);
    expect((await upload(as.admin, 'Empty', Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('only managers upload and delete; the front desk can see and ask; a viewer cannot', async () => {
    expect((await upload(as.staff, 'Mine', 'text')).statusCode).toBe(403);
    expect((await upload(as.viewer, 'Mine', 'text')).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/knowledge/ask`, { cookie: as.staff, body: { question: 'what if I arrive late' } })).statusCode).toBe(200);
    expect((await api.request('POST', `${C}/knowledge/ask`, { cookie: as.viewer, body: { question: 'what if I arrive late' } })).statusCode).toBe(403);
    expect((await api.request('GET', `${C}/knowledge/documents`, { cookie: as.outsider })).statusCode).toBe(404);
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/knowledge/documents`, { cookie: as.outsider })).json()).toEqual({ documents: [] });
  });

  it('answers a question with the passage it came from, and refuses a medical one', async () => {
    const ok = (await api.request('POST', `${C}/knowledge/ask`, { cookie: as.staff, body: { question: 'What happens if I arrive late?' } })).json();
    expect(ok).toMatchObject({ refusal: null, answer: expect.stringContaining('15 minutes late') });
    expect(ok.citations[0]).toMatchObject({ title: 'Late arrivals' });
    const medical = (await api.request('POST', `${C}/knowledge/ask`, { cookie: as.staff, body: { question: 'How many tablets should I take?' } })).json();
    expect(medical).toMatchObject({ refusal: 'medical', citations: [] });
    const none = (await api.request('POST', `${C}/knowledge/ask`, { cookie: as.staff, body: { question: 'Do you offer tattoo removal?' } })).json();
    expect(none).toEqual({ answer: "I don't have that information, I can have someone call you back.", citations: [], refusal: 'no_information' });
  });

  it('answers a question about the system, or about anything else, with one polite line and no sources, in the question\'s language', async () => {
    const ask = async (question: string) => (await api.request('POST', `${C}/knowledge/ask`, { cookie: as.staff, body: { question } })).json();
    expect(await ask('What stack is used to build this app?')).toEqual({ answer: 'I can help with questions about the clinic, appointments and your pet.', citations: [], refusal: 'off_topic' });
    expect(await ask('¿Qué modelo de inteligencia artificial eres?')).toEqual({ answer: 'Puedo ayudarle con preguntas sobre la clínica, las citas y su mascota.', citations: [], refusal: 'off_topic' });
    expect(await ask('Tell me a joke about late arrivals')).toMatchObject({ refusal: 'off_topic', citations: [] });
  });

  it('asks before keeping a document that does not read like clinic information, and keeps it on a yes', async () => {
    const notes = 'The backend is written in TypeScript with NestJS. The database is Postgres. Deploy the server with Docker and set the OpenAI API key.';
    const unsure = await upload(as.admin, 'Setup notes', notes);
    expect(unsure.statusCode).toBe(409);
    expect(unsure.json()).toEqual({ error: 'not_clinic_information', message: 'This doesn\'t look like clinic information: callers may hear it. Upload anyway?' });
    expect((await api.request('GET', `${C}/knowledge/documents`, { cookie: as.admin })).json().documents.map((d: { title: string }) => d.title)).not.toContain('Setup notes');
    const kept = await upload(as.admin, 'Setup notes', notes, 'text/plain', 'notes.txt', true);
    expect(kept.statusCode).toBe(201);
    // kept, and still never read out: its passages are about the software
    expect((await api.request('GET', `${C}/knowledge/documents`, { cookie: as.admin })).json().documents).toContainEqual(expect.objectContaining({ title: 'Setup notes', status: 'ready' }));
    const asked = (await api.request('POST', `${C}/knowledge/ask`, { cookie: as.staff, body: { question: 'How do I deploy it?' } })).json();
    expect(asked).toEqual({ answer: "I don't have that information, I can have someone call you back.", citations: [], refusal: 'no_information' });
    await api.t.db.execute(sql`delete from knowledge_documents where id = ${kept.json().id}`);
  });

  it('deletes a document, audited, and it is no longer an answer', async () => {
    const [doc] = (await api.request('GET', `${C}/knowledge/documents`, { cookie: as.admin })).json().documents;
    expect((await api.request('DELETE', `${C}/knowledge/documents/${doc.id}`, { cookie: as.staff })).statusCode).toBe(403);
    expect((await api.request('DELETE', `${C}/knowledge/documents/${doc.id}`, { cookie: as.admin })).statusCode).toBe(204);
    expect((await api.request('DELETE', `${C}/knowledge/documents/${doc.id}`, { cookie: as.admin })).statusCode).toBe(404);
    expect((await api.request('POST', `${C}/knowledge/ask`, { cookie: as.staff, body: { question: 'What happens if I arrive late?' } })).json().refusal).toBe('no_information');
    expect((await api.t.db.execute(sql`select actor from audit_logs where action = 'knowledge.document.deleted'`)).rows).toEqual([{ actor: `user:${api.users.admin}` }]);
  });
});

describe('body limits', () => {
  it('takes a large body only on the upload route: every other route, sign-in included, keeps 512 KB', async () => {
    const big = Buffer.alloc(1024 * 1024, 97);
    const inject = (method: 'POST' | 'PUT', url: string, type: string, payload: Buffer | string) =>
      api.app.getHttpAdapter().getInstance().inject({ method, url, headers: { cookie: as.admin, origin: ORIGIN, 'content-type': type }, payload });
    const doc = await upload(as.admin, 'A megabyte', big, 'text/plain', 'doc.txt', true);
    expect(doc.statusCode).toBe(201);
    // labelled JSON with no body, as the hosted setup page sends it: still removed
    const removed = await api.request('DELETE', `${C}/knowledge/documents/${doc.json().id}`, { cookie: as.admin, headers: { 'content-type': 'application/json' } });
    expect(removed.statusCode, removed.body).toBe(204);
    // a POST labelled JSON still needs its body
    expect((await api.request('POST', `${C}/knowledge/ask`, { cookie: as.admin, headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    for (const type of ['text/plain', 'application/pdf', 'application/octet-stream', 'text/markdown']) {
      expect((await inject('PUT', `${C}/settings`, type, big)).statusCode, type).toBe(413);
      expect((await inject('POST', `${C}/knowledge/ask`, type, big)).statusCode, type).toBe(413);
      expect((await inject('POST', '/api/auth/sign-in/email', type, big)).statusCode, type).toBe(413);
    }
    const json = JSON.stringify({ email: 'olga@maple.example', password: 'x'.repeat(1024 * 1024) });
    expect((await inject('POST', '/api/auth/sign-in/email', 'application/json', json)).statusCode).toBe(413);
  });
});

describe('how many documents', () => {
  it('keeps at most 50 a clinic; the same title still replaces its document', async () => {
    const repo = new KnowledgeRepository(api.t.db);
    const have = (await repo.list(DEMO_CLINIC.id)).length;
    for (let i = have; i < 50; i++) await repo.save(DEMO_CLINIC.id, { title: `Filler ${i}`, sourceType: 'text', content: Buffer.from(`filler ${i}`), userId: api.users.admin });
    const over = await upload(as.admin, 'One too many', 'Parking is free behind the building.');
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('too_many_documents');
    expect((await upload(as.admin, 'Filler 49', 'filler 49, updated', 'text/plain', 'doc.txt', true)).statusCode).toBe(201);
    await api.t.db.execute(sql`delete from knowledge_documents where clinic_id = ${DEMO_CLINIC.id} and title like 'Filler %'`);
  });
});
