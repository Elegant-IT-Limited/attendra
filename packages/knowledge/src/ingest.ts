// SPDX-License-Identifier: AGPL-3.0-only
import type { DocumentStats, KnowledgeRepository } from '@attendra/db';
import { chunkText, MAX_CHUNK_CHARS, PAGE_BREAK } from './chunk';
import type { Embedder } from './embed';
import { extractDocument, KnowledgeError } from './extract';

/** The most chunks one document may have: about 200,000 tokens, the ceiling on what indexing it can cost. */
export const MAX_CHUNKS = 400;

/**
 * Indexes one document: text, chunks, embeddings, and the chunks swapped in one
 * transaction. The same content with the same model is left as it is, so the job can
 * run twice. A document that cannot be read fails with a code and is not retried; a
 * model that cannot be reached is retried by the queue.
 *
 * How much text was found, and on how many pages, is kept with the document either
 * way, so Settings can say "12 pages, 18,400 characters" and spot a scan with no text.
 */
export async function indexDocument(repo: KnowledgeRepository, embedder: Embedder, clinicId: string, documentId: string): Promise<'indexed' | 'current' | 'gone' | 'stale' | 'failed'> {
  const doc = await repo.forIndexing(clinicId, documentId, embedder.model);
  if (!doc) return 'gone';
  if (doc.current) return 'current';
  let chunks;
  let stats: DocumentStats | undefined;
  try {
    const extracted = await extractDocument(doc.content, doc.sourceType);
    stats = statsOf(extracted.text, extracted.pageCount);
    chunks = chunkText(extracted.text);
    if (!chunks.length) throw new KnowledgeError('empty');
    if (chunks.length > MAX_CHUNKS) throw new KnowledgeError('too_many_chunks');
    // never the case with chunkText's own limit; a guard, so no chunk is ever embedded cut short
    if (chunks.some((c) => c.body.length > MAX_CHUNK_CHARS)) throw new KnowledgeError('chunk_too_long');
  } catch (err) {
    await repo.markFailed(clinicId, documentId, err instanceof KnowledgeError ? err.code : 'unreadable', stats);
    return 'failed';
  }
  let vectors: number[][];
  try {
    vectors = await embedder.embed(chunks.map((c) => (c.heading ? `${c.heading}\n${c.body}` : c.body)));
  } catch (err) {
    await repo.markFailed(clinicId, documentId, err instanceof KnowledgeError ? err.code : 'embedding_failed');
    throw err; // the queue tries again later
  }
  const done = await repo.replaceChunks(clinicId, documentId, doc.hash, embedder.model, chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })), stats);
  return done === 'replaced' ? 'indexed' : 'stale'; // stale: a newer upload came in, and its own job indexes it
}

/** The characters of text found (page breaks and runs of white space not counted), and the pages. */
export function statsOf(text: string, pageCount: number | null): DocumentStats {
  return { extractedChars: text.replaceAll(PAGE_BREAK, '').replace(/\s+/g, ' ').trim().length, pageCount };
}
