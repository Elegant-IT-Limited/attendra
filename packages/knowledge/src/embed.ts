// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { KnowledgeError } from './extract';
import { topicWords } from './words';

export const DIMENSIONS = 1536;

export interface Embedder {
  /** Stored with every chunk: vectors from different models are never compared. */
  readonly model: string;
  /** Cosine distance past which a chunk is not about the question at all. Depends on the model. */
  readonly maxDistance: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI embeddings, text-embedding-3-small by default. The model comes from
 * ATTENDRA_EMBEDDING_MODEL. Each request has a timeout, and the inputs are capped per
 * request and per document, which is the ceiling on what indexing one document can
 * cost. The embeddings endpoint keeps no conversation state and takes no `store`
 * setting. pg-boss retries a failed indexing job, so the client does not.
 */
export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly openai: Pick<OpenAI, 'embeddings'>,
    readonly model = 'text-embedding-3-small',
    readonly maxDistance = 0.7,
    private readonly limits = { timeoutMs: 30_000, batch: 64, maxInputs: 400, maxCharsPerInput: 8_000 },
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length > this.limits.maxInputs) throw new KnowledgeError('too_many_chunks');
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.limits.batch) {
      const input = texts.slice(i, i + this.limits.batch).map((t) => t.slice(0, this.limits.maxCharsPerInput));
      let res;
      try {
        res = await this.openai.embeddings.create({ model: this.model, input, dimensions: DIMENSIONS }, { timeout: this.limits.timeoutMs, maxRetries: 0 });
      } catch (err) {
        const status = (err as { status?: number }).status;
        throw new KnowledgeError(status ? `embedding_http_${status}` : 'embedding_unreachable');
      }
      out.push(...res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}

/**
 * Embeddings with no model: each word, and each pair of neighbouring words, is hashed
 * into one of 1,536 dimensions, and the vector is normalised. Texts that share topic
 * words come out close. It is deterministic, so tests and evals use it, and it keeps the
 * demo's knowledge search working with no OpenAI key. It knows nothing about
 * meaning: "car park" is not near "parking".
 */
export class LocalEmbedder implements Embedder {
  readonly model = 'local-hash-1536';
  readonly maxDistance = 0.8;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(DIMENSIONS).fill(0);
      // topic words only: "do you" in a question is not a reason to match a chunk
      const words = topicWords(t);
      const add = (feature: string, weight: number) => {
        const h = createHash('sha256').update(feature).digest();
        v[h.readUInt32BE(0) % DIMENSIONS]! += (h[4]! & 1 ? 1 : -1) * weight;
      };
      words.forEach((w, i) => { add(w, 1); if (i) add(`${words[i - 1]} ${w}`, 0.5); });
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
