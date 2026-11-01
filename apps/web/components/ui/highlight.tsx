// SPDX-License-Identifier: AGPL-3.0-only
import { fold } from '@attendra/core';
import { Fragment } from 'react';

const plain = (s: string) => fold(s).toLowerCase();
const mark = 'rounded-sm bg-primary/15 px-0 text-inherit';

/**
 * The part of a search result that matched, wrapped in <mark>: each word typed where it
 * starts in the text (accents and case aside), or, for digits, the digits typed where they
 * sit in a phone number however it is written ("0162" lights up the end of "(720) 555-0162").
 * Nothing is marked when the match was not on this text, as with a name that only sounds alike.
 */
export function Highlight({ text, query }: { text: string | null | undefined; query: string }) {
  if (!text) return null;
  const q = query.trim();
  if (!q) return <>{text}</>;
  const ranges = /^[\d\s()+.-]+$/.test(q) ? digitRanges(text, q.replace(/\D/g, '')) : wordRanges(text, q);
  if (!ranges.length) return <>{text}</>;
  const parts: { s: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ s: text.slice(at, start), hit: false });
    parts.push({ s: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ s: text.slice(at), hit: false });
  return <>{parts.map((p, i) => (p.hit ? <mark key={i} className={mark}>{p.s}</mark> : <Fragment key={i}>{p.s}</Fragment>))}</>;
}

/** Where each word typed starts a word of the text, as [start, end) in the text, merged and in order. */
function wordRanges(text: string, query: string): [number, number][] {
  const hay = plain(text);
  // folding keeps the length of Latin text, so positions in the folded text are positions in the original
  if (hay.length !== text.length) return [];
  const typed = plain(query).split(/[^\p{L}\p{M}\p{N}'-]+/u).filter(Boolean);
  const found: [number, number][] = [];
  for (const w of typed) {
    const re = /[\p{L}\p{M}\p{N}'-]+/gu;
    for (let m = re.exec(hay); m; m = re.exec(hay)) if (m[0].startsWith(w)) found.push([m.index, m.index + w.length]);
  }
  return merge(found);
}

/** Where the digits typed sit in the digits of the text, as a range over the text's own characters. */
function digitRanges(text: string, digits: string): [number, number][] {
  if (!digits) return [];
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) if (/\d/.test(text[i]!)) positions.push(i);
  const all = positions.map((i) => text[i]).join('');
  const found: [number, number][] = [];
  for (let from = all.indexOf(digits); from >= 0; from = all.indexOf(digits, from + 1)) found.push([positions[from]!, positions[from + digits.length - 1]! + 1]);
  return merge(found);
}

function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
  }
  return out;
}
