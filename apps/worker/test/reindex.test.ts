import { DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, KnowledgeRepository, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { indexDocument, LocalEmbedder } from '@attendra/knowledge';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DocumentJob, noJobs } from '../src/queue';
import { queueReindex } from '../src/reindex';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
let repo: KnowledgeRepository;
const embedder = new LocalEmbedder();

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, createPhiCipher(TEST_DATA_KEY));
  repo = new KnowledgeRepository(t.db);
  for (const [title, text] of [['Parking', 'Parking is free in the lot behind the clinic. Enter from Elm Street.'], ['Fees', 'A wellness exam for a dog or a cat is 65 dollars, paid at the visit.']] as const) {
    const { id } = await repo.save(DEMO_CLINIC.id, { title, sourceType: 'text', content: Buffer.from(text), userId: 'u_test' });
    await indexDocument(repo, embedder, DEMO_CLINIC.id, id);
  }
});
afterAll(() => t.close());

describe('re-indexing documents chunked by older rules', () => {
  it('a dry run counts them and queues nothing; --apply queues each once, with ids only; indexed again, they are current', async () => {
    // one document as it was before migration 0047: indexed, with no text counted
    await t.db.execute(sql`update knowledge_documents set extracted_chars = null where title = 'Fees'`);
    const jobs: DocumentJob[] = [];
    const queue = { ...noJobs, indexDocument: async (j: DocumentJob) => { jobs.push(j); } };
    expect(await queueReindex(t.db, queue, { apply: false, version: 'reindex-test' })).toEqual({ clinics: 1, documents: 1, ready: 1, failedEmpty: 0, queued: 0 });
    expect(jobs).toEqual([]);
    expect(await queueReindex(t.db, queue, { apply: true, version: 'reindex-test' })).toMatchObject({ documents: 1, queued: 1 });
    expect(jobs).toEqual([{ clinicId: DEMO_CLINIC.id, documentId: expect.any(String), hash: expect.stringMatching(/^[0-9a-f]{64}$/), version: 'reindex-test' }]);
    // the worker runs the job: the document is indexed again, and nothing is left to do
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, jobs[0]!.documentId)).toBe('indexed');
    expect(await queueReindex(t.db, queue, { apply: false, version: 'reindex-test' })).toMatchObject({ documents: 0 });
  });
});
