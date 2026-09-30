// SPDX-License-Identifier: AGPL-3.0-only
import type { SourceType } from '@attendra/db';
import { Worker } from 'node:worker_threads';

export const MAX_BYTES = 5 * 1024 * 1024;
/** Limits on a PDF, which is read in a worker thread of its own. */
export const PDF_LIMITS = { maxPages: 200, maxChars: 2 * 1024 * 1024, timeoutMs: 30_000, maxHeapMb: 256 };

/** Thrown with a code, never with text from the document. */
export class KnowledgeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'KnowledgeError'; }
}

/** What an upload's file name or media type says it is, or null for anything else. */
export function sourceTypeOf(name: string, mediaType?: string): SourceType | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (mediaType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mediaType === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (mediaType === 'text/plain' || ext === 'txt') return 'text';
  return null;
}

/** The document's text: as it is for text and markdown, page by page for a PDF. */
export async function extractText(content: Buffer, type: SourceType): Promise<string> {
  if (content.length > MAX_BYTES) throw new KnowledgeError('too_large');
  if (type !== 'pdf') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(content);
    if (text.includes('\u0000')) throw new KnowledgeError('not_text');
    return text;
  }
  if (content.subarray(0, 5).toString('latin1') !== '%PDF-') throw new KnowledgeError('not_a_pdf');
  return pdfInWorker(content, PDF_LIMITS);
}

/**
 * A PDF's text, read in a worker thread with its own heap limit and a deadline: at
 * most `maxPages` pages and `maxChars` characters of text. A PDF over a limit, one
 * that takes too long, or one that crashes the thread fails with a code.
 */
export function pdfInWorker(content: Buffer, limits: typeof PDF_LIMITS): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.mjs', import.meta.url), {
      workerData: { bytes: content, maxPages: limits.maxPages, maxChars: limits.maxChars },
      resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16 },
      // the thread needs no loader and no flags of the service's
      execArgv: [],
      stdout: true, stderr: true,
    });
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); fn(); };
    const timer = setTimeout(() => finish(() => reject(new KnowledgeError('pdf_timeout'))), limits.timeoutMs);
    worker.once('message', (m: { text?: string; error?: string }) => finish(() => (typeof m.text === 'string' ? resolve(m.text) : reject(new KnowledgeError(m.error ?? 'pdf_unreadable')))));
    worker.once('error', (err: Error & { code?: string }) => finish(() => reject(new KnowledgeError(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'pdf_too_complex' : 'pdf_unreadable'))));
    worker.once('exit', () => finish(() => reject(new KnowledgeError('pdf_unreadable'))));
  });
}
