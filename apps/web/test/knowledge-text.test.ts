import { describe, expect, it } from 'vitest';
import { documentStats, looksScanned } from '../lib/knowledge';

describe('what Settings says a document gave', () => {
  const doc = { extractedChars: 18_400, pageCount: 12, chunkCount: 14, status: 'ready' };
  it('pages, characters and parts, as the server counted them', () => {
    expect(documentStats(doc)).toBe('12 pages · 18,400 characters · 14 parts');
    expect(documentStats({ ...doc, pageCount: null, chunkCount: 1, extractedChars: 102 })).toBe('102 characters · 1 part');
    expect(documentStats({ ...doc, pageCount: 1, status: 'failed', extractedChars: 0 })).toBe('1 page · 0 characters');
    expect(documentStats({ ...doc, extractedChars: null })).toBeNull();
  });

  it('asks whether a PDF with little text a page is a scan', () => {
    expect(looksScanned(doc)).toBe(false);
    expect(looksScanned({ extractedChars: 1_000, pageCount: 12 })).toBe(true);
    expect(looksScanned({ extractedChars: 40, pageCount: null })).toBe(false);
    expect(looksScanned({ extractedChars: null, pageCount: 12 })).toBe(false);
  });
});
