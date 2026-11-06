// SPDX-License-Identifier: AGPL-3.0-only

/** Fewer characters a page than this, and a PDF is most likely a scan: pictures of text, which cannot be read. */
export const SCAN_CHARS_PER_PAGE = 200;

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What indexing found in a document, as Settings shows it: "12 pages · 18,400
 * characters · 14 parts". Pages only for a PDF; null before it was indexed.
 */
export function documentStats(d: { extractedChars: number | null; pageCount: number | null; chunkCount: number; status: string }): string | null {
  if (d.extractedChars === null) return null;
  return [
    d.pageCount !== null ? count(d.pageCount, 'page', 'pages') : null,
    count(d.extractedChars, 'character', 'characters'),
    d.status === 'ready' ? count(d.chunkCount, 'part', 'parts') : null,
  ].filter(Boolean).join(' · ');
}

/** A PDF with little text for its pages: most likely a scan, which callers would hear nothing from. */
export function looksScanned(d: { extractedChars: number | null; pageCount: number | null }): boolean {
  return d.extractedChars !== null && !!d.pageCount && d.extractedChars / d.pageCount < SCAN_CHARS_PER_PAGE;
}
