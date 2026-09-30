// SPDX-License-Identifier: AGPL-3.0-only
import type { KnowledgeRepository } from '@attendra/db';
import { chunkText } from './chunk';
import type { Embedder } from './embed';
import { extractText, KnowledgeError } from './extract';

/** The most chunks one document may have: about 200,000 tokens, the ceiling on what indexing it can cost. */
export const MAX_CHUNKS = 400;

/**
 * Indexes one document: text, chunks, embeddings, and the chunks swapped in one
 * transaction. The same content with the same model is left as it is, so the job can
 * run twice. A document that cannot be read fails with a code and is not retried; a
 * model that cannot be reached is retried by the queue.
 */
export async function indexDocument(repo: KnowledgeRepository, embedder: Embedder, clinicId: string, documentId: string): Promise<'indexed' | 'current' | 'gone' | 'stale' | 'failed'> {
  const doc = await repo.forIndexing(clinicId, documentId, embedder.model);
  if (!doc) return 'gone';
  if (doc.current) return 'current';
  let chunks;
  try {
    chunks = chunkText(await extractText(doc.content, doc.sourceType));
    if (!chunks.length) throw new KnowledgeError('empty');
    if (chunks.length > MAX_CHUNKS) throw new KnowledgeError('too_many_chunks');
  } catch (err) {
    await repo.markFailed(clinicId, documentId, err instanceof KnowledgeError ? err.code : 'unreadable');
    return 'failed';
  }
  let vectors: number[][];
  try {
    vectors = await embedder.embed(chunks.map((c) => (c.heading ? `${c.heading}\n${c.body}` : c.body)));
  } catch (err) {
    await repo.markFailed(clinicId, documentId, err instanceof KnowledgeError ? err.code : 'embedding_failed');
    throw err; // the queue tries again later
  }
  const done = await repo.replaceChunks(clinicId, documentId, doc.hash, embedder.model, chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })));
  return done === 'replaced' ? 'indexed' : 'stale'; // stale: a newer upload came in, and its own job indexes it
}
