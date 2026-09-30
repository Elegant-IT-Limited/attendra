// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { type Database, type Tx, withClinic } from '../client';

export type SourceType = 'text' | 'markdown' | 'pdf';
export type DocumentStatus = 'queued' | 'indexing' | 'ready' | 'failed';

export interface KnowledgeDocument {
  id: string; title: string; sourceType: SourceType; sizeBytes: number; status: DocumentStatus; failure: string | null;
  chunkCount: number; embeddingModel: string | null; uploadedByUserId: string; createdAt: Date; updatedAt: Date;
}

export interface NewChunk { ordinal: number; heading: string | null; body: string; tokenCount: number; embedding: number[] }
export interface FoundChunk { id: number; documentId: string; title: string; heading: string | null; body: string; distance?: number }

const actor = (userId: string) => `user:${userId}`;
const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
/** pgvector's text form: [0.1,0.2,...] */
export const vectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

function toDocument(r: Record<string, unknown>): KnowledgeDocument {
  return {
    id: String(r.id), title: String(r.title), sourceType: r.source_type as SourceType, sizeBytes: Number(r.size_bytes), status: r.status as DocumentStatus,
    failure: (r.failure as string | null) ?? null, chunkCount: Number(r.chunk_count), embeddingModel: (r.embedding_model as string | null) ?? null,
    uploadedByUserId: String(r.uploaded_by_user_id), createdAt: new Date(r.created_at as string), updatedAt: new Date(r.updated_at as string),
  };
}

const COLUMNS = sql.raw('id, title, source_type, size_bytes, status, failure, chunk_count, embedding_model, uploaded_by_user_id, created_at, updated_at');

/**
 * The clinic's documents and their chunks. Documents are clinic information, never
 * patient data; uploads and deletes are audited like any other change to what the
 * assistant says.
 */
/** How long a document may stay in indexing before a save of the same bytes queues it again. */
export const INDEXING_STALE_MS = 15 * 60_000;

export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  /**
   * Saves an upload. A document is known by its title: the same title again replaces
   * it. The same bytes again change nothing and are not indexed twice, so a retried
   * upload is harmless, but only while the document is indexed (or being indexed)
   * with the current embedding model: after a model change, or for a document stuck
   * waiting or failed, the same bytes queue it again. `version` names this save, so
   * the index job for it is its own.
   */
  async save(clinicId: string, d: { title: string; sourceType: SourceType; content: Buffer; userId: string; embeddingModel?: string }): Promise<{ id: string; changed: boolean; hash: string; version: string }> {
    const hash = createHash('sha256').update(d.content).digest('hex');
    return withClinic(this.db, clinicId, async (tx) => {
      const [existing] = rows<{ id: string; content_hash: string; status: string; embedding_model: string | null; updated_at: string }>(await tx.execute(sql`
        select id, content_hash, status, embedding_model, updated_at from knowledge_documents where clinic_id = ${clinicId} and title = ${d.title}`));
      // indexing counts as current only with this model, and only while it is recent: a job
      // that died mid-way leaves the document in indexing, and after 15 minutes it is queued again
      const model = !d.embeddingModel || existing?.embedding_model === d.embeddingModel;
      const stale = existing?.status === 'indexing' && Date.now() - new Date(existing.updated_at).getTime() > INDEXING_STALE_MS;
      const current = existing && existing.content_hash === hash && model && (existing.status === 'ready' || (existing.status === 'indexing' && !stale));
      if (existing && current) return { id: existing.id, changed: false, hash, version: new Date(existing.updated_at).toISOString() };
      const [row] = rows<{ id: string; updated_at: string }>(await tx.execute(sql`
        insert into knowledge_documents (clinic_id, title, source_type, content, content_hash, size_bytes, uploaded_by_user_id)
        values (${clinicId}, ${d.title}, ${d.sourceType}, ${d.content}, ${hash}, ${d.content.length}, ${d.userId})
        on conflict (clinic_id, title) do update set source_type = excluded.source_type, content = excluded.content, content_hash = excluded.content_hash,
          size_bytes = excluded.size_bytes, uploaded_by_user_id = excluded.uploaded_by_user_id, status = 'queued', failure = null, updated_at = now()
        returning id, updated_at`));
      await tx.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id, counts) values
        (${clinicId}, ${actor(d.userId)}, 'knowledge.document.uploaded', 'knowledge_document', ${row!.id}, ${JSON.stringify({ bytes: d.content.length })}::jsonb)`);
      return { id: row!.id, changed: true, hash, version: new Date(row!.updated_at).toISOString() };
    });
  }

  async list(clinicId: string): Promise<KnowledgeDocument[]> {
    return withClinic(this.db, clinicId, async (tx) => rows<Record<string, unknown>>(await tx.execute(sql`select ${COLUMNS} from knowledge_documents where clinic_id = ${clinicId} order by title`)).map(toDocument));
  }

  async get(clinicId: string, id: string): Promise<KnowledgeDocument | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [r] = rows<Record<string, unknown>>(await tx.execute(sql`select ${COLUMNS} from knowledge_documents where clinic_id = ${clinicId} and id = ${id}`));
      return r ? toDocument(r) : null;
    });
  }

  /** Deletes a document and its chunks, audited. */
  async remove(clinicId: string, id: string, userId: string): Promise<boolean> {
    return withClinic(this.db, clinicId, async (tx) => {
      const gone = rows<{ id: string }>(await tx.execute(sql`delete from knowledge_documents where clinic_id = ${clinicId} and id = ${id} returning id`));
      if (!gone.length) return false;
      await tx.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id) values (${clinicId}, ${actor(userId)}, 'knowledge.document.deleted', 'knowledge_document', ${id})`);
      return true;
    });
  }

  /** What the indexer needs, and whether this content is already indexed with this model. */
  async forIndexing(clinicId: string, id: string, model: string): Promise<{ content: Buffer; sourceType: SourceType; hash: string; current: boolean } | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [r] = rows<{ content: Uint8Array; source_type: SourceType; content_hash: string; indexed_hash: string | null; embedding_model: string | null; status: string }>(
        await tx.execute(sql`select content, source_type, content_hash, indexed_hash, embedding_model, status from knowledge_documents where clinic_id = ${clinicId} and id = ${id}`));
      if (!r) return null;
      // with the model it indexes with, and when it started, so a save can tell a live job from a dead one
      await tx.execute(sql`update knowledge_documents set status = 'indexing', embedding_model = ${model}, updated_at = now() where clinic_id = ${clinicId} and id = ${id} and status <> 'ready'`);
      return { content: Buffer.from(r.content), sourceType: r.source_type, hash: r.content_hash, current: r.status === 'ready' && r.indexed_hash === r.content_hash && r.embedding_model === model };
    });
  }

  /** Swaps a document's chunks for new ones in one transaction, unless the document changed again meanwhile. */
  async replaceChunks(clinicId: string, id: string, hash: string, model: string, chunks: NewChunk[]): Promise<'replaced' | 'stale'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [doc] = rows<{ content_hash: string }>(await tx.execute(sql`select content_hash from knowledge_documents where clinic_id = ${clinicId} and id = ${id} for update`));
      if (!doc || doc.content_hash !== hash) return 'stale';
      await tx.execute(sql`delete from knowledge_chunks where clinic_id = ${clinicId} and document_id = ${id}`);
      for (const c of chunks) await insertChunk(tx, clinicId, id, model, c);
      await tx.execute(sql`update knowledge_documents set status = 'ready', failure = null, chunk_count = ${chunks.length}, indexed_hash = ${hash}, embedding_model = ${model}, updated_at = now()
        where clinic_id = ${clinicId} and id = ${id}`);
      return 'replaced';
    });
  }

  async markFailed(clinicId: string, id: string, code: string) {
    await withClinic(this.db, clinicId, (tx) => tx.execute(sql`update knowledge_documents set status = 'failed', failure = ${code.slice(0, 60)}, updated_at = now() where clinic_id = ${clinicId} and id = ${id}`));
  }

  /** The nearest chunks by cosine distance, among those embedded with this model. */
  async nearest(clinicId: string, embedding: number[], model: string, k = 20): Promise<FoundChunk[]> {
    return withClinic(this.db, clinicId, async (tx) => rows<Record<string, unknown>>(await tx.execute(sql`
      select c.id, c.document_id, d.title, c.heading, c.body, c.embedding <=> ${vectorLiteral(embedding)}::vector as distance
      from knowledge_chunks c join knowledge_documents d on d.clinic_id = c.clinic_id and d.id = c.document_id
      where c.clinic_id = ${clinicId} and c.model = ${model} and d.status = 'ready'
      order by distance limit ${k}`)).map(toChunk));
  }

  /** The best full-text matches for these words, any one of them counting, and a word of three letters or more as a prefix: "park" finds "parking". */
  async matching(clinicId: string, words: string[], k = 20): Promise<FoundChunk[]> {
    const terms = words.map((w) => w.toLowerCase()).filter((w) => /^[\p{L}\p{M}\p{N}]+$/u.test(w)).slice(0, 30);
    if (!terms.length) return [];
    const query = terms.map((t) => `'${t.replace(/'/g, "''")}'${[...t].length >= 3 ? ':*' : ''}`).join(' | ');
    return withClinic(this.db, clinicId, async (tx) => rows<Record<string, unknown>>(await tx.execute(sql`
      select c.id, c.document_id, d.title, c.heading, c.body from knowledge_chunks c join knowledge_documents d on d.clinic_id = c.clinic_id and d.id = c.document_id
      where c.clinic_id = ${clinicId} and d.status = 'ready' and c.tsv @@ to_tsquery('simple', ${query})
      order by ts_rank(c.tsv, to_tsquery('simple', ${query})) desc limit ${k}`)).map(toChunk));
  }
}

async function insertChunk(tx: Tx, clinicId: string, documentId: string, model: string, c: NewChunk) {
  await tx.execute(sql`insert into knowledge_chunks (clinic_id, document_id, ordinal, heading, body, token_count, embedding, model)
    values (${clinicId}, ${documentId}, ${c.ordinal}, ${c.heading}, ${c.body}, ${c.tokenCount}, ${vectorLiteral(c.embedding)}::vector, ${model})`);
}

const toChunk = (r: Record<string, unknown>): FoundChunk => ({
  id: Number(r.id), documentId: String(r.document_id), title: String(r.title), heading: (r.heading as string | null) ?? null, body: String(r.body),
  ...(r.distance === undefined ? {} : { distance: Number(r.distance) }),
});
