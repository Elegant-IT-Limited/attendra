import { DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, KnowledgeRepository, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerQuestion, chunkText, extractDocument, HybridKnowledgeBase, indexDocument, LocalAnswerer, LocalEmbedder, MAX_CHUNK_CHARS, OpenAIEmbedder, PAGE_BREAK, statsOf } from '../src';
import { CALLBACK_WORDS, DENTAL_LINE, pdfOf, policies, priceList } from './fixtures/make-pdfs';

// Two real PDFs, made by fixtures/make-pdfs.ts and checked in: a price list (no sentence ends, no blank lines) on 3
// pages, and 12 pages of policies. Made-up content for an invented clinic.
const PRICE_LIST = readFileSync(new URL('./fixtures/price-list.pdf', import.meta.url));
const POLICIES = readFileSync(new URL('./fixtures/policies.pdf', import.meta.url));

describe('the PDF fixtures', () => {
  it('are the ones the script makes, so the test and the files cannot drift apart', () => {
    expect(pdfOf(priceList()).equals(PRICE_LIST)).toBe(true);
    expect(pdfOf(policies()).equals(POLICIES)).toBe(true);
  });
});

describe('extracting and chunking a long PDF', () => {
  it('counts the pages, and keeps a price list\'s lines', async () => {
    const prices = await extractDocument(PRICE_LIST, 'pdf');
    expect(prices.pageCount).toBe(3);
    expect(prices.text.split(PAGE_BREAK)).toHaveLength(3);
    expect(prices.text).toContain(`\n${DENTAL_LINE}\n`);
    const rules = await extractDocument(POLICIES, 'pdf');
    expect(rules.pageCount).toBe(12);
    expect(statsOf(rules.text, rules.pageCount)).toEqual({ extractedChars: expect.any(Number), pageCount: 12 });
    expect(statsOf(rules.text, rules.pageCount).extractedChars).toBeGreaterThan(12 * 2000);
  });

  it('splits a price list with no sentence ends at its lines, more than one chunk a page, none over 2,000 characters', async () => {
    const chunks = chunkText((await extractDocument(PRICE_LIST, 'pdf')).text);
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    for (const c of chunks) expect(c.body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // each chunk knows its page, and every item is in a chunk whole, on its own line
    expect(new Set(chunks.map((c) => c.heading))).toEqual(new Set(['Page 1', 'Page 2', 'Page 3']));
    expect(chunks.filter((c) => c.body.split('\n').includes(DENTAL_LINE)).map((c) => c.heading)).toContain('Page 2');
  });

  it('splits 12 pages of policies into more chunks than pages, none over 2,000 characters', async () => {
    const chunks = chunkText((await extractDocument(POLICIES, 'pdf')).text);
    expect(chunks.length).toBeGreaterThan(12);
    expect(chunks.length).toBeLessThan(60);
    for (const c of chunks) expect(c.body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.find((c) => c.body.includes(CALLBACK_WORDS))?.heading).toBe('Page 9');
  });

  it('splits a line longer than a chunk at its words, and a word longer than a chunk where it must', () => {
    const line = 'exam '.repeat(1000).trim();
    const chunks = chunkText(`# Prices\n${line}\nnext line`);
    for (const c of chunks) expect(c.body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.map((c) => c.body).join(' ')).toContain('next line');
    for (const c of chunkText('x'.repeat(5000))) expect(c.body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('embeds every chunk whole: one too long for the model fails with a code, never cut short', async () => {
    const create = async (body: { input: string[] }) => ({ data: body.input.map((_t, index) => ({ index, embedding: [body.input[index]!.length] })) });
    const e = new OpenAIEmbedder({ embeddings: { create } } as never);
    // the embedding is the input's length here: what was sent is what was given
    expect(await e.embed(['a'.repeat(2100)])).toEqual([[2100]]);
    await expect(e.embed(['a'.repeat(8001)])).rejects.toThrow('chunk_too_long');
  });
});

describe('finding answers in long PDFs', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  let repo: KnowledgeRepository;
  const embedder = new LocalEmbedder();
  let kb: HybridKnowledgeBase;

  beforeAll(async () => {
    t = await openTestDatabase();
    await seedDemo(t.db, createPhiCipher(TEST_DATA_KEY));
    repo = new KnowledgeRepository(t.db);
    kb = new HybridKnowledgeBase(repo, embedder);
    for (const [title, content] of [['Price list', PRICE_LIST], ['Clinic policies', POLICIES]] as const) {
      const { id } = await repo.save(DEMO_CLINIC.id, { title, sourceType: 'pdf', content, userId: 'u_test' });
      expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, id)).toBe('indexed');
    }
  });
  afterAll(() => t.close());

  it('keeps each document\'s pages and characters, with sensible chunk counts', async () => {
    const docs = await repo.list(DEMO_CLINIC.id);
    const prices = docs.find((d) => d.title === 'Price list')!;
    const rules = docs.find((d) => d.title === 'Clinic policies')!;
    expect(prices).toMatchObject({ status: 'ready', pageCount: 3, extractedChars: expect.any(Number) });
    expect(prices.chunkCount).toBeGreaterThanOrEqual(6);
    expect(prices.extractedChars! / prices.pageCount!).toBeGreaterThan(200);
    expect(rules).toMatchObject({ status: 'ready', pageCount: 12 });
    expect(rules.chunkCount).toBeGreaterThan(12);
  });

  it('"what\'s in the price?" finds the dental line', async () => {
    const found = await kb.search(DEMO_CLINIC.id, 'What\'s in the price?');
    expect(found.some((p) => p.text.includes(DENTAL_LINE))).toBe(true);
    const answer = await answerQuestion(kb, new LocalAnswerer(), DEMO_CLINIC.id, 'What\'s in the price?');
    expect(answer.refusal).toBeNull();
    expect(answer.citations.some((p) => p.text.includes(DENTAL_LINE))).toBe(true);
  });

  it('"call me back" finds the callback policy', async () => {
    const found = await kb.search(DEMO_CLINIC.id, 'call me back');
    expect(found[0]?.title).toBe('Clinic policies');
    expect(found.some((p) => p.text.includes(CALLBACK_WORDS))).toBe(true);
    const answer = await answerQuestion(kb, new LocalAnswerer(), DEMO_CLINIC.id, 'Can you call me back?');
    expect(answer.refusal).toBeNull();
    expect(answer.answer).toMatch(/call you back|callback/i);
  });

  it('a scan with no text fails as empty, and keeps its page count, so Settings can ask whether it is a scan', async () => {
    const scan = pdfOf([[], [], [], []]);
    const { id } = await repo.save(DEMO_CLINIC.id, { title: 'Scanned form', sourceType: 'pdf', content: scan, userId: 'u_test' });
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, id)).toBe('failed');
    expect(await repo.get(DEMO_CLINIC.id, id)).toMatchObject({ status: 'failed', failure: 'empty', pageCount: 4, extractedChars: 0 });
  });

  it('indexes again a document chunked by older rules, and leaves a current one alone', async () => {
    const [doc] = (await repo.list(DEMO_CLINIC.id)).filter((d) => d.title === 'Price list');
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, doc!.id)).toBe('current');
    // as a document indexed before migration 0047 looks
    await t.owner.execute(sql`update knowledge_documents set extracted_chars = null, page_count = null where id = ${doc!.id}`);
    expect(await indexDocument(repo, embedder, DEMO_CLINIC.id, doc!.id)).toBe('indexed');
    expect(await repo.get(DEMO_CLINIC.id, doc!.id)).toMatchObject({ status: 'ready', pageCount: 3 });
  });
});
