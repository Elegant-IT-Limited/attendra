// SPDX-License-Identifier: AGPL-3.0-only
import type { KnowledgeBase, KnowledgePassage } from '@attendra/core';
import type { FoundChunk, KnowledgeRepository } from '@attendra/db';
import type { Embedder } from './embed';
import { topicWords } from './words';

/**
 * Reciprocal rank fusion: each list gives a chunk 1 / (k + rank), and the sums
 * decide. A chunk near the top of both lists wins; one that only one search found
 * still counts. k = 60 is the usual constant.
 */
export function fuse(lists: FoundChunk[][], keep = 4, k = 60): FoundChunk[] {
  const scores = new Map<number, { chunk: FoundChunk; score: number }>();
  for (const list of lists) {
    list.forEach((chunk, rank) => {
      const s = scores.get(chunk.id) ?? { chunk, score: 0 };
      s.score += 1 / (k + rank + 1);
      scores.set(chunk.id, s);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id).slice(0, keep).map((s) => s.chunk);
}

/**
 * Hybrid search over the clinic's documents: the vector search's top 20 and the
 * full-text search's top 20, fused, keeping 4. The full text finds names and exact
 * words ("Cigna", "Suite 3"); the vectors find the rest. Only chunks embedded with
 * the current model take part in the vector search.
 */
export class HybridKnowledgeBase implements KnowledgeBase {
  constructor(private readonly repo: KnowledgeRepository, private readonly embedder: Embedder, private readonly keep = 4) {}

  async search(clinicId: string, question: string): Promise<KnowledgePassage[]> {
    const [vector] = await this.embedder.embed([question]);
    const [near, words] = await Promise.all([this.repo.nearest(clinicId, vector!, this.embedder.model, 20), this.repo.matching(clinicId, topicWords(question), 20)]);
    // the vector search always has a nearest chunk; past the model's distance it is not about the question
    const close = near.filter((c) => (c.distance ?? 0) <= this.embedder.maxDistance);
    return fuse([close, words], this.keep).map((c) => ({ documentId: c.documentId, title: c.title, text: c.heading ? `${c.heading}\n${c.body}` : c.body }));
  }
}
