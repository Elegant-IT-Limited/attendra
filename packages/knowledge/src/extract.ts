// SPDX-License-Identifier: AGPL-3.0-only
import type { SourceType } from '@attendra/db';
import { Worker } from 'node:worker_threads';
import { PAGE_BREAK } from './chunk';

export const MAX_BYTES = 5 * 1024 * 1024;
/** Documents per clinic: each one is embedded and stored, so the count is bounded. */
export const MAX_DOCUMENTS = 50;
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

/** A document's text, and its pages: null for text and markdown, which have none. */
export interface Extracted { text: string; pageCount: number | null }

/** The document's text: as it is for text and markdown, page by page for a PDF. */
export async function extractText(content: Buffer, type: SourceType): Promise<string> {
  return (await extractDocument(content, type)).text;
}

/** The document's text and page count. A PDF's pages are separated by PAGE_BREAK. */
export async function extractDocument(content: Buffer, type: SourceType): Promise<Extracted> {
  if (content.length > MAX_BYTES) throw new KnowledgeError('too_large');
  if (type !== 'pdf') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(content);
    if (text.includes('\u0000')) throw new KnowledgeError('not_text');
    // a form feed in a text file is not a page of ours
    return { text: text.replaceAll(PAGE_BREAK, '\n'), pageCount: null };
  }
  if (content.subarray(0, 5).toString('latin1') !== '%PDF-') throw new KnowledgeError('not_a_pdf');
  return pdfInWorker(content, PDF_LIMITS);
}

/**
 * A PDF's text, read in a worker thread with its own heap limit and a deadline: at
 * most `maxPages` pages and `maxChars` characters of text. A PDF over a limit, one
 * that takes too long, or one that crashes the thread fails with a code.
 */
export function pdfInWorker(content: Buffer, limits: typeof PDF_LIMITS): Promise<Extracted> {
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
    worker.once('message', (m: { text?: string; pages?: number; error?: string }) => finish(() => (typeof m.text === 'string' ? resolve({ text: m.text, pageCount: m.pages ?? null }) : reject(new KnowledgeError(m.error ?? 'pdf_unreadable')))));
    worker.once('error', (err: Error & { code?: string }) => finish(() => reject(new KnowledgeError(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'pdf_too_complex' : 'pdf_unreadable'))));
    worker.once('exit', () => finish(() => reject(new KnowledgeError('pdf_unreadable'))));
  });
}
