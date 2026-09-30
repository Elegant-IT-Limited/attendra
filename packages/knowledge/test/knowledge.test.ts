import { DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, KnowledgeRepository, saveClinic, seedDemo, withClinic } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  answerQuestion, chunkText, DEMO_DOCUMENTS, estimateTokens, extractText, fuse, HybridKnowledgeBase, indexDocument, LocalAnswerer, LocalEmbedder,
  MEDICAL_REFUSAL, ModelAnswerer, NO_INFORMATION, OpenAIEmbedder, PDF_LIMITS, pdfInWorker, seedDemoKnowledge, sourceTypeOf, topicWords,
} from '../src';

/** A PDF with one line of text on each of its pages, built by hand so the test needs no fixture file. */
function pdfWith(line: string, pages = 1): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const pageIds = Array.from({ length: pages }, (_, i) => i + 5);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pageIds.map(() => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>'),
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('reading documents', () => {
  it('knows text, markdown and PDF by name or media type, and nothing else', () => {
    expect(sourceTypeOf('parking.md')).toBe('markdown');
    expect(sourceTypeOf('Policies.PDF')).toBe('pdf');
    expect(sourceTypeOf('notes.txt')).toBe('text');
    expect(sourceTypeOf('upload', 'application/pdf')).toBe('pdf');
    expect(sourceTypeOf('scan.docx')).toBeNull();
  });

  it('reads the text of a PDF', async () => {
    expect(await extractText(pdfWith('Parking is free behind the building.'), 'pdf')).toContain('Parking is free behind the building.');
  });

  it('refuses a file that is not what it says, or too large, with a code', async () => {
    await expect(extractText(Buffer.from('hello'), 'pdf')).rejects.toThrow('not_a_pdf');
    await expect(extractText(Buffer.from('%PDF-1.4 broken'), 'pdf')).rejects.toThrow('pdf_unreadable');
  });

  it('reads a PDF in its own thread, up to 200 pages and 2 MB of text, within a deadline', async () => {
    expect(PDF_LIMITS).toMatchObject({ maxPages: 200, maxChars: 2 * 1024 * 1024 });
    expect((await extractText(pdfWith('Page text.', 3), 'pdf')).match(/Page text\./g)).toHaveLength(3);
    await expect(extractText(pdfWith('One too many.', 201), 'pdf')).rejects.toThrow('too_many_pages');
    const strict = { ...PDF_LIMITS, maxChars: 20 };
    await expect(pdfInWorker(pdfWith('This line is longer than twenty characters.'), strict)).rejects.toThrow('too_much_text');
    await expect(pdfInWorker(pdfWith('Slow.', 50), { ...PDF_LIMITS, timeoutMs: 1 })).rejects.toThrow('pdf_timeout');
    await expect(extractText(Buffer.alloc(5 * 1024 * 1024 + 1, 97), 'text')).rejects.toThrow('too_large');
  });
});

describe('chunking', () => {
  it('keeps each chunk under its heading', () => {
    const chunks = chunkText(DEMO_DOCUMENTS[0].text);
    expect(chunks.map((c) => c.heading)).toEqual(['Parking', 'By bus', 'Getting in']);
    expect(chunks[0]!.body).toContain('free in the lot');
  });

  it('makes chunks of about the target size, overlapping at the edges, and splits a long paragraph at sentences', () => {
    const sentence = 'Our front desk answers the phone from eight in the morning until five in the afternoon on weekdays. ';
    const long = `# Hours\n${sentence.repeat(60)}\n\nSecond paragraph about Saturdays.`;
    const chunks = chunkText(long, { target: 200, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(260);
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1]!.body.slice(-60);
      expect(chunks[i]!.body.includes(tail.slice(-30))).toBe(true);
    }
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
  });
});

describe('search helpers', () => {
  it('local embeddings are deterministic, and texts that share words are closer', async () => {
    const e = new LocalEmbedder();
    const [a, b, c, a2] = await e.embed(['free parking behind the building', 'where is the parking', 'we accept cigna insurance', 'free parking behind the building']);
    const cos = (x: number[], y: number[]) => x.reduce((n, v, i) => n + v * y[i]!, 0);
    expect(a).toEqual(a2);
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
    expect(a!.length).toBe(1536);
  });

  it('fuses rankings so a chunk high in both lists wins', () => {
    const c = (id: number) => ({ id, documentId: 'd', title: 't', heading: null, body: `chunk ${id}` });
    expect(fuse([[c(1), c(2), c(3)], [c(2), c(3), c(9)]], 2).map((x) => x.id)).toEqual([2, 3]);
    expect(fuse([[c(1)], [c(4)]], 4).map((x) => x.id)).toEqual([1, 4]); // found by only one search still counts
  });

  it('drops the words that say nothing about the topic', () => {
    expect(topicWords('Where do I park?')).toEqual(['park']);
    expect(topicWords('¿Dónde está el estacionamiento?')).toEqual(['estacionamiento']);
  });

  it('the OpenAI embedder sends the model, the dimensions and a timeout, and fails with a code', async () => {
    const create = vi.fn(async (body: { input: string[] }) => ({ data: body.input.map((_t, index) => ({ index, embedding: [index] })) }));
    const e = new OpenAIEmbedder({ embeddings: { create } } as never, 'text-embedding-3-small');
    expect(await e.embed(['a', 'b'])).toEqual([[0], [1]]);
    expect(create).toHaveBeenCalledWith({ model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 1536 }, { timeout: 30_000, maxRetries: 0 });
    const failing = new OpenAIEmbedder({ embeddings: { create: async () => { throw Object.assign(new Error('Parking is free'), { status: 429 }); } } } as never);
    await expect(failing.embed(['x'])).rejects.toThrow('embedding_http_429');
    await expect(e.embed(Array.from({ length: 401 }, () => 'x'))).rejects.toThrow('too_many_chunks');
  });

  it('the model answerer keeps store off and answers from the passages', async () => {
    const create = vi.fn(async () => ({ output_text: 'Parking is free behind the building.' }));
    const a = new ModelAnswerer({ responses: { create } } as never, 'gpt-test');
    expect(await a.answer('where do I park', [{ documentId: 'd', title: 'Parking and directions', text: 'Parking is free behind the building.' }])).toBe('Parking is free behind the building.');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-test', store: false, max_output_tokens: 200 }), { timeout: 20_000, maxRetries: 0 });
  });
});

describe('the clinic\'s knowledge, in Postgres', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  let repo: KnowledgeRepository;
  const embedder = new LocalEmbedder();
  let kb: HybridKnowledgeBase;
  const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };

  beforeAll(async () => {
    t = await openTestDatabase();
    await seedDemo(t.db, createPhiCipher(TEST_DATA_KEY));
    await saveClinic(t.db, 'org_other', OTHER);
    await seedDemoKnowledge(t.db, embedder);
    repo = new KnowledgeRepository(t.db);
    kb = new HybridKnowledgeBase(repo, embedder);
  });
  afterAll(() => t.close());

  it('indexes the demo documents into chunks', async () => {
    const docs = await repo.list(DEMO_CLINIC.id);
    expect(docs.map((d) => [d.title, d.status])).toEqual([
      ['Insurance we accept', 'ready'], ['Medications and refills', 'ready'], ['Parking and directions', 'ready'], ['Preparing for blood work', 'ready'],
    ]);
    expect(docs.every((d) => d.chunkCount > 0 && d.embeddingModel === 'local-hash-1536')).toBe(true);
  });

  it('finds the passage that answers the question', async () => {
    expect((await kb.search(DEMO_CLINIC.id, 'where can I park my car'))[0]).toMatchObject({ title: 'Parking and directions', text: expect.stringContaining('Parking is free') });
    expect((await kb.search(DEMO_CLINIC.id, 'do you take Cigna'))[0]?.title).toBe('Insurance we accept');
    expect((await kb.search(DEMO_CLINIC.id, 'do I need to fast before blood work'))[0]?.title).toBe('Preparing for blood work');
    expect((await kb.search(DEMO_CLINIC.id, 'which bus goes there'))[0]?.text).toContain('10 and 15 buses');
    expect((await kb.search(DEMO_CLINIC.id, 'do you take Cigna')).length).toBeLessThanOrEqual(4);
  });

  it('answers from the full text alone when the embedding is late or fails, without keeping the caller waiting', async () => {
    const hanging = { model: embedder.model, maxDistance: embedder.maxDistance, embed: () => new Promise<number[][]>(() => {}) };
    const started = Date.now();
    const found = await new HybridKnowledgeBase(repo, hanging, 4, 100).search(DEMO_CLINIC.id, 'do you take Cigna');
    // the embedding never answers: the 100 ms fallback, not a hang, however busy the machine
    expect(Date.now() - started).toBeLessThan(5000);
    expect(found[0]?.title).toBe('Insurance we accept');
    const failing = { ...hanging, embed: async () => { throw new Error('embedding_unreachable'); } };
    expect((await new HybridKnowledgeBase(repo, failing).search(DEMO_CLINIC.id, 'do you take Cigna'))[0]?.title).toBe('Insurance we accept');
  });

  it('finds nothing for a question the documents do not answer', async () => {
    expect(await kb.search(DEMO_CLINIC.id, 'do you do tattoo removal?')).toEqual([]);
    expect(await kb.search(DEMO_CLINIC.id, 'what is it?')).toEqual([]);
  });

  it('answers locally from the passage\'s opening, past its heading, not its last paragraph', async () => {
    const text = 'Parking and directions\nParking is free in the lot behind the clinic. Enter from Elm Street.\n\nThe garage on 5th Avenue is also close.';
    expect(await new LocalAnswerer().answer('where do I park?', [{ documentId: 'd', title: 'Parking and directions', text }]))
      .toBe('Parking is free in the lot behind the clinic. Enter from Elm Street.');
  });

  it('answers with citations, refuses a medical question before searching, and says so when it does not know', async () => {
    const ok = await answerQuestion(kb, new LocalAnswerer(), DEMO_CLINIC.id, 'where do I park?');
    expect(ok).toMatchObject({ refusal: null, answer: expect.stringContaining('Parking is free') });
    expect(ok.citations[0]?.title).toBe('Parking and directions');
    const search = vi.spyOn(kb, 'search');
    expect(await answerQuestion(kb, new LocalAnswerer(), DEMO_CLINIC.id, 'how much metformin should I take?')).toEqual({ answer: MEDICAL_REFUSAL, citations: [], refusal: 'medical' });
    expect(search).not.toHaveBeenCalled();
    search.mockRestore();
    expect(await answerQuestion(kb, new LocalAnswerer(), DEMO_CLINIC.id, 'do you do tattoo removal?')).toEqual({ answer: NO_INFORMATION, citations: [], refusal: 'no_information' });
  });

  it('keeps each clinic\'s documents to itself', async () => {
    expect(await kb.search(OTHER.id, 'where can I park')).toEqual([]);
    expect(await withClinic(t.db, OTHER.id, (tx) => tx.execute(sql`select count(*)::int as n from knowledge_chunks`))).toMatchObject({ rows: [{ n: 0 }] });
  });

  it('re-indexes the same bytes after the embedding model changes, and a document stuck waiting', async () => {
    const doc = { title: 'Insurance we accept', sourceType: 'markdown' as const, content: Buffer.from(DEMO_DOCUMENTS[1].text), userId: 'u_olga' };
    expect((await repo.save(DEMO_CLINIC.id, { ...doc, embeddingModel: embedder.model })).changed).toBe(false); // indexed with this model
    const moved = await repo.save(DEMO_CLINIC.id, { ...doc, embeddingModel: 'text-embedding-4' });
    expect(moved.changed).toBe(true);
    expect((await repo.get(DEMO_CLINIC.id, moved.id))?.status).toBe('queued');
    // still waiting (its job lost): the same bytes queue it again, as a new version
    const again = await repo.save(DEMO_CLINIC.id, { ...doc, embeddingModel: 'text-embedding-4' });
    expect(again.changed).toBe(true);
    expect(again.version).not.toBe(moved.version);
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, moved.id)).toBe('indexed');
    expect((await repo.save(DEMO_CLINIC.id, { ...doc, embeddingModel: embedder.model })).changed).toBe(false);
  });

  it('counts a document being indexed as current only with the same model, and only for 15 minutes', async () => {
    const doc = { title: 'Late fees', sourceType: 'text' as const, content: Buffer.from('A missed visit without a day\'s notice may be charged.'), userId: 'u_olga' };
    const first = await repo.save(DEMO_CLINIC.id, { ...doc, embeddingModel: embedder.model });
    await repo.forIndexing(DEMO_CLINIC.id, first.id, embedder.model); // a job picks it up, and is still at it
    expect((await repo.save(DEMO_CLINIC.id, { ...doc, embeddingModel: embedder.model })).changed).toBe(false);
    // being indexed with the old model is not current once the model changes
    expect((await repo.save(DEMO_CLINIC.id, { ...doc, embeddingModel: 'text-embedding-4' })).changed).toBe(true);
    // a job that died mid-way: 16 minutes in indexing, and the same bytes queue it again
    await repo.forIndexing(DEMO_CLINIC.id, first.id, embedder.model);
    await t.db.execute(sql`update knowledge_documents set updated_at = now() - interval '16 minutes' where id = ${first.id}`);
    expect((await repo.save(DEMO_CLINIC.id, { ...doc, embeddingModel: embedder.model })).changed).toBe(true);
    expect((await repo.get(DEMO_CLINIC.id, first.id))?.status).toBe('queued');
  });

  it('indexes an unchanged upload once, replaces the chunks of a changed one, and audits both', async () => {
    const first = await repo.save(DEMO_CLINIC.id, { title: 'Parking and directions', sourceType: 'markdown', content: Buffer.from(DEMO_DOCUMENTS[0].text), userId: 'u_ana' });
    expect(first.changed).toBe(false);
    const changed = await repo.save(DEMO_CLINIC.id, { title: 'Parking and directions', sourceType: 'markdown', content: Buffer.from('# Parking\nThe lot is now under the building, entrance on Oak Street.'), userId: 'u_ana' });
    expect(changed).toEqual({ id: first.id, changed: true, hash: expect.stringMatching(/^[0-9a-f]{64}$/), version: expect.any(String) });
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, changed.id)).toBe('indexed');
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, changed.id)).toBe('current');
    expect((await kb.search(DEMO_CLINIC.id, 'where can I park'))[0]?.text).toContain('Oak Street');
    expect((await repo.get(DEMO_CLINIC.id, changed.id))?.chunkCount).toBe(1);
    const audits = (await t.db.execute(sql`select actor, action from audit_logs where entity = 'knowledge_document' and actor = 'user:u_ana'`)).rows;
    expect(audits).toEqual([{ actor: 'user:u_ana', action: 'knowledge.document.uploaded' }]); // the unchanged upload wrote nothing
  });

  it('a PDF upload is indexed; a broken one fails with a code and is not retried', async () => {
    const pdf = await repo.save(DEMO_CLINIC.id, { title: 'Provider bios', sourceType: 'pdf', content: pdfWith('Dr. Okafor has practised family medicine in Denver since 2011.'), userId: 'u_ana' });
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, pdf.id)).toBe('indexed');
    expect((await kb.search(DEMO_CLINIC.id, 'how long has Dr. Okafor practised'))[0]?.title).toBe('Provider bios');
    const broken = await repo.save(DEMO_CLINIC.id, { title: 'Scan', sourceType: 'pdf', content: Buffer.from('%PDF-1.4 nothing here'), userId: 'u_ana' });
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, broken.id)).toBe('failed');
    expect(await repo.get(DEMO_CLINIC.id, broken.id)).toMatchObject({ status: 'failed', failure: 'pdf_unreadable' });
  });

  it('deleting a document removes its chunks, audited', async () => {
    const [doc] = (await repo.list(DEMO_CLINIC.id)).filter((d) => d.title === 'Provider bios');
    expect(await repo.remove(DEMO_CLINIC.id, doc!.id, 'u_ana')).toBe(true);
    expect(await kb.search(DEMO_CLINIC.id, 'how long has Dr. Okafor practised')).toEqual([]);
    expect(await repo.remove(OTHER.id, doc!.id, 'u_ana')).toBe(false);
    expect((await t.db.execute(sql`select action from audit_logs where action = 'knowledge.document.deleted'`)).rows).toHaveLength(1);
  });
});
