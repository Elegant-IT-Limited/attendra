import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The colours a filter pill, a tab and body text use, read from the theme itself, in both themes: WCAG AA (4.5:1) for
// normal text. A CI run once caught the Requests "Open" filter mid colour-change; the pills no longer transition, and
// this keeps the tokens themselves above the line.
const css = readFileSync(join(import.meta.dirname, '../app/globals.css'), 'utf8');
const block = (selector: RegExp) => css.slice(css.search(selector)).split('}')[0]!;
const tokens = (text: string) => Object.fromEntries([...text.matchAll(/--([a-z-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)].map((m) => [m[1]!, [Number(m[2]), Number(m[3]), Number(m[4])] as const]));

function luminance([l, c, h]: readonly [number, number, number]) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.396337 * a + 0.215803 * b) ** 3;
  const m_ = (l - 0.105561 * a - 0.063854 * b) ** 3;
  const s_ = (l - 0.089484 * a - 1.291485 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const r = clamp(4.076741 * l_ - 3.307711 * m_ + 0.230969 * s_);
  const g = clamp(-1.268438 * l_ + 2.609757 * m_ - 0.341319 * s_);
  const bl = clamp(-0.004196 * l_ - 0.703418 * m_ + 1.707614 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
const ratio = (x: readonly [number, number, number], y: readonly [number, number, number]) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('text colours pass AA in both themes', () => {
  const light = tokens(block(/\[data-theme=['"]?light['"]?\]\s*\{/));
  const dark = tokens(block(/\[data-theme=['"]?dark['"]?\]\s*\{/));
  for (const [theme, t] of [['light', light], ['dark', dark]] as const) {
    it(`${theme}: a pressed pill, an unpressed one, body text`, () => {
      expect(ratio(t['on-primary']!, t.primary!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['text-muted']!, t.surface!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['text-muted']!, t['surface-raised']!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.text!, t.surface!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
