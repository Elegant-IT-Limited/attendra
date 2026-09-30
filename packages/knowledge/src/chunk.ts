// SPDX-License-Identifier: AGPL-3.0-only

export interface Chunk { ordinal: number; heading: string | null; body: string; tokenCount: number }

/** About four characters to a token for English prose; close enough to size chunks, never used for billing. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/**
 * Splits a document by headings and paragraphs into chunks of about `target` tokens.
 * A chunk keeps the heading it sits under, so "Parking" travels with the paragraph
 * about the lot. Neighbouring chunks under one heading share their edge paragraph
 * (`overlap` tokens of it at most), so an answer that spans the break is found from
 * either side. A paragraph longer than a chunk is split at sentences.
 */
export function chunkText(text: string, opts: { target?: number; overlap?: number } = {}): Chunk[] {
  const target = opts.target ?? 500;
  const overlap = opts.overlap ?? 60;
  const sections: { heading: string | null; paragraphs: string[] }[] = [{ heading: null, paragraphs: [] }];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const h = lines[0]!.match(HEADING);
    if (h) {
      sections.push({ heading: h[2]!.trim(), paragraphs: [] });
      if (lines.length > 1) sections.at(-1)!.paragraphs.push(lines.slice(1).join(' '));
    } else {
      sections.at(-1)!.paragraphs.push(lines.join(' '));
    }
  }

  const chunks: Chunk[] = [];
  const push = (heading: string | null, parts: string[]) => {
    const body = parts.join('\n\n').trim();
    if (body) chunks.push({ ordinal: chunks.length, heading, body, tokenCount: estimateTokens(`${heading ?? ''} ${body}`) });
  };
  for (const s of sections) {
    const pieces = s.paragraphs.flatMap((p) => (estimateTokens(p) > target ? splitSentences(p, target) : [p]));
    let current: string[] = [];
    let size = 0;
    for (const piece of pieces) {
      const n = estimateTokens(piece);
      if (current.length && size + n > target) {
        push(s.heading, current);
        // carry the last paragraph over, trimmed to the overlap, so the edge is in both chunks
        const tail = current.at(-1)!;
        const carried = estimateTokens(tail) <= overlap ? tail : tail.slice(-overlap * 4).replace(/^\S*\s/, '');
        current = [carried];
        size = estimateTokens(carried);
      }
      current.push(piece);
      size += n;
    }
    push(s.heading, current);
  }
  return chunks;
}

function splitSentences(paragraph: string, target: number): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [paragraph];
  const out: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (current && estimateTokens(current + s) > target) { out.push(current.trim()); current = ''; }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
