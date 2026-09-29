// SPDX-License-Identifier: AGPL-3.0-only
import type { SourceType } from '@attendra/db';
import { extractText as pdfText, getDocumentProxy } from 'unpdf';

export const MAX_BYTES = 5 * 1024 * 1024;

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
  try {
    const pdf = await getDocumentProxy(new Uint8Array(content));
    const { text } = await pdfText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).join('\n\n');
  } catch {
    throw new KnowledgeError('pdf_unreadable');
  }
}
