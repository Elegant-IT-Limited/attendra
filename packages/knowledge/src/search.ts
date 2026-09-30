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
 *
 * A caller is waiting on the line, so the question's embedding gets `embedTimeoutMs`
 * (4 seconds). If it is not back by then, or it fails, the answer comes from the
 * full-text search alone.
 */
export class HybridKnowledgeBase implements KnowledgeBase {
  constructor(private readonly repo: KnowledgeRepository, private readonly embedder: Embedder, private readonly keep = 4, private readonly embedTimeoutMs = 4_000) {}

  async search(clinicId: string, question: string): Promise<KnowledgePassage[]> {
    const [vector, words] = await Promise.all([this.embedQuestion(question), this.repo.matching(clinicId, topicWords(question), 20)]);
    const near = vector ? await this.repo.nearest(clinicId, vector, this.embedder.model, 20) : [];
    // the vector search always has a nearest chunk; past the model's distance it is not about the question
    const close = near.filter((c) => (c.distance ?? 0) <= this.embedder.maxDistance);
    return fuse([close, words], this.keep).map((c) => ({ documentId: c.documentId, title: c.title, text: c.heading ? `${c.heading}\n${c.body}` : c.body }));
  }

  /** The question's vector, or null when the embedding is late or failed. */
  private embedQuestion(question: string): Promise<number[] | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.embedTimeoutMs); });
    const vector = this.embedder.embed([question]).then(([v]) => v ?? null, () => null);
    return Promise.race([vector, late]).finally(() => clearTimeout(timer));
  }
}
