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

const upload = (cookie: string, title: string, body: Buffer | string, type = 'text/plain', name = 'doc.txt') => api.app.getHttpAdapter().getInstance().inject({
  method: 'POST', url: `${C}/knowledge/documents?${new URLSearchParams({ title, name })}`, headers: { cookie, origin: ORIGIN, 'content-type': type }, payload: body,
});

beforeAll(async () => {
  api = await startApi({
    demoMode: false,
    // the worker's job, run straight away
    jobs: { callCompleted: async () => {}, webhookEvent: async () => {}, indexDocument: async (j) => { queued.push(j); await indexDocument(new KnowledgeRepository(api.t.db), embedder, j.clinicId, j.documentId); } },
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
    const list = (await api.request('GET', `${C}/knowledge/documents`, { cookie: as.viewer })).json();
    expect(list.documents).toEqual([expect.objectContaining({ title: 'Late arrivals', status: 'ready', chunkCount: 1 })]);
    expect((await api.t.db.execute(sql`select action from audit_logs where action = 'knowledge.document.uploaded'`)).rows).toHaveLength(1);
  });

  it('refuses a file type it cannot read, one over 5 MB, and an empty one', async () => {
    expect((await upload(as.admin, 'Scan', Buffer.from([1, 2, 3]), 'application/octet-stream', 'scan.docx')).statusCode).toBe(415);
    expect((await upload(as.admin, 'Huge', Buffer.alloc(5 * 1024 * 1024 + 1, 97))).statusCode).toBe(413);
    expect((await upload(as.admin, 'Empty', Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('only managers upload and delete; front desk and viewers can see and ask', async () => {
    expect((await upload(as.staff, 'Mine', 'text')).statusCode).toBe(403);
    expect((await upload(as.viewer, 'Mine', 'text')).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/knowledge/ask`, { cookie: as.viewer, body: { question: 'what if I arrive late' } })).statusCode).toBe(200);
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

  it('deletes a document, audited, and it is no longer an answer', async () => {
    const [doc] = (await api.request('GET', `${C}/knowledge/documents`, { cookie: as.admin })).json().documents;
    expect((await api.request('DELETE', `${C}/knowledge/documents/${doc.id}`, { cookie: as.staff })).statusCode).toBe(403);
    expect((await api.request('DELETE', `${C}/knowledge/documents/${doc.id}`, { cookie: as.admin })).statusCode).toBe(204);
    expect((await api.request('DELETE', `${C}/knowledge/documents/${doc.id}`, { cookie: as.admin })).statusCode).toBe(404);
    expect((await api.request('POST', `${C}/knowledge/ask`, { cookie: as.staff, body: { question: 'What happens if I arrive late?' } })).json().refusal).toBe('no_information');
    expect((await api.t.db.execute(sql`select actor from audit_logs where action = 'knowledge.document.deleted'`)).rows).toEqual([{ actor: `user:${api.users.admin}` }]);
  });
});
