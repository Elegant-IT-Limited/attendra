// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, documentsToReindex } from '@attendra/db';
import type { JobQueue } from './queue';

export interface ReindexCounts { clinics: number; documents: number; ready: number; failedEmpty: number; queued: number }

/**
 * Queues the documents chunked by older rules to be indexed again, by the running
 * worker, with its own embedding model: the same job an upload queues. A document
 * stays searchable while its job runs, and its chunks are swapped in one transaction.
 * Counts only, never a title or a word of text. `apply: false` queues nothing.
 */
export async function queueReindex(db: Database, jobs: JobQueue, opts: { apply: boolean; version: string }): Promise<ReindexCounts> {
  const docs = await documentsToReindex(db);
  let queued = 0;
  if (opts.apply) {
    for (const d of docs) {
      await jobs.indexDocument({ clinicId: d.clinicId, documentId: d.id, hash: d.hash, version: opts.version });
      queued++;
    }
  }
  return {
    clinics: new Set(docs.map((d) => d.clinicId)).size, documents: docs.length,
    ready: docs.filter((d) => d.status === 'ready').length, failedEmpty: docs.filter((d) => d.status === 'failed').length, queued,
  };
}
