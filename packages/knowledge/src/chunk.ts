// SPDX-License-Identifier: AGPL-3.0-only

export interface Chunk { ordinal: number; heading: string | null; body: string; tokenCount: number }

/** About four characters to a token for English prose; close enough to size chunks, never used for billing. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** The most characters in one chunk's body. Every chunk is embedded whole, so nothing past it is ever dropped. */
export const MAX_CHUNK_CHARS = 2_000;
/** A heading is a title: a longer one is cut, so a chunk and its heading always fit one embedding. */
export const MAX_HEADING_CHARS = 200;
/** Between two pages of a PDF in the extracted text (a form feed, the page-break character). */
export const PAGE_BREAK = '\f';

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

interface Section { heading: string | null; paragraphs: string[] }

/**
 * Splits a document by headings and paragraphs into chunks of about `target` tokens,
 * and never more than 2,000 characters. A chunk keeps the heading it sits under, so
 * "Parking" travels with the paragraph about the lot; a PDF's pages are headings of
 * their own ("Page 3"), so a chunk knows its page. Neighbouring chunks under one
 * heading share their edge (`overlap` tokens of it at most), so an answer that spans
 * the break is found from either side.
 *
 * A paragraph longer than a chunk is split at sentences. A price list or a table has
 * none, and no blank lines either: two 580 KB PDFs came out as one chunk a page, and
 * their prices were never found. So text with no sentence ends is split at its line
 * breaks, and a line longer than a chunk at its words.
 */
export function chunkText(text: string, opts: { target?: number; overlap?: number } = {}): Chunk[] {
  const max = Math.min(MAX_CHUNK_CHARS, (opts.target ?? 500) * 4);
  const overlap = Math.min((opts.overlap ?? 60) * 4, Math.floor(max / 4));
  // pieces leave room for the overlap carried in front of them, so a chunk never passes `max`
  const pieceMax = max - overlap - 2;
  const chunks: Chunk[] = [];
  const push = (heading: string | null, parts: string[]) => {
    const body = parts.join('\n\n').trim();
    if (body) chunks.push({ ordinal: chunks.length, heading, body, tokenCount: estimateTokens(`${heading ?? ''} ${body}`) });
  };
  for (const s of sectionsOf(text)) {
    let current: string[] = [];
    for (const piece of s.paragraphs.flatMap((p) => fit(p, pieceMax))) {
      if (current.length && current.join('\n\n').length + 2 + piece.length > max) {
        push(s.heading, current);
        // carry the edge over, so it is in both chunks
        const carried = tailOf(current.at(-1)!, overlap);
        current = carried ? [carried] : [];
      }
      current.push(piece);
    }
    push(s.heading, current);
  }
  return chunks;
}

/** The document as headed sections of paragraphs: a heading line starts one, and so does each page of a PDF. */
function sectionsOf(text: string): Section[] {
  const pages = text.replace(/\r\n?/g, '\n').split(PAGE_BREAK);
  const paged = pages.length > 1;
  const sections: Section[] = [];
  pages.forEach((page, i) => {
    sections.push({ heading: paged ? `Page ${i + 1}` : null, paragraphs: [] });
    for (const block of page.split(/\n\s*\n/)) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const h = lines[0]?.match(HEADING);
      if (h) {
        const title = h[2]!.trim().slice(0, MAX_HEADING_CHARS);
        sections.push({ heading: paged ? `${title} (page ${i + 1})` : title, paragraphs: [] });
        lines.shift();
      }
      if (lines.length) sections.at(-1)!.paragraphs.push(paragraphOf(lines));
    }
  });
  return sections;
}

const sentenceEnds = (text: string) => (text.match(/[.!?](\s|$)/g) ?? []).length;

/**
 * A block's lines as one paragraph. Prose wrapped over several lines is joined with
 * spaces; a list (a price list, a table: lines with hardly a sentence end among them)
 * keeps its line breaks, so each item stays on its own line and can be split there.
 */
function paragraphOf(lines: string[]): string {
  const list = lines.length >= 3 && sentenceEnds(lines.join(' ')) * 3 < lines.length;
  return lines.join(list ? '\n' : ' ');
}

/** A paragraph in pieces of at most `max` characters: at line breaks, else at sentences, else at words. */
function fit(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph];
  if (paragraph.includes('\n')) return pack(paragraph.split('\n'), '\n', max);
  const sentences = (paragraph.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
  if (sentences.length > 1) return pack(sentences, ' ', max);
  const words = paragraph.split(/\s+/).filter(Boolean);
  if (words.length > 1) return pack(words, ' ', max);
  // one word longer than a chunk (a long code or a link): cut where it must be
  return Array.from({ length: Math.ceil(paragraph.length / max) }, (_, i) => paragraph.slice(i * max, (i + 1) * max));
}

/** Units joined with `sep` into as few pieces of at most `max` characters as they go, in order. */
function pack(units: string[], sep: string, max: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const unit of units.flatMap((u) => (u.length > max ? fit(u, max) : [u]))) {
    if (current && current.length + sep.length + unit.length > max) { out.push(current); current = unit; } else current = current ? current + sep + unit : unit;
  }
  if (current) out.push(current);
  return out;
}

/** The last `n` characters of a piece, from a whole line for a list, else from a whole word. */
function tailOf(piece: string, n: number): string {
  if (piece.length <= n) return piece;
  if (piece.includes('\n')) {
    const lines = piece.split('\n');
    let tail = '';
    for (let i = lines.length - 1; i >= 0 && tail.length + lines[i]!.length + 1 <= n; i--) tail = tail ? `${lines[i]}\n${tail}` : lines[i]!;
    if (tail) return tail;
  }
  return piece.slice(-n).replace(/^\S*\s/, '');
}
