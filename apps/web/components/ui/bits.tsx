// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Tooltip } from '@/components/ui/overlay';
import { ago } from '@/lib/format';
import { cn } from '@/lib/utils';

/** A person as initials in a circle. The colour comes from the name, so it stays the same everywhere. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-medium text-text', size === 'sm' ? 'size-6 text-xs' : 'size-8 text-sm')}
      style={{ background: `oklch(0.9 0.04 ${hue} / 0.9)` }}>
      <span className="text-[oklch(0.3_0.04_255)]">{initials}</span>
    </span>
  );
}

/** A key, as it is printed on the keyboard. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border-strong bg-surface-sunken px-1 font-sans text-xs text-text-muted">{children}</kbd>;
}

/**
 * A number that counts to its new value when it changes, never on first load, and
 * not at all for people who ask for less motion.
 */
export function AnimatedNumber({ value, format = (n) => String(Math.round(n)) }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    const from = last.current;
    last.current = value;
    if (from === value) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); return; }
    const start = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 400);
      setShown(from + (value - from) * (1 - (1 - p) ** 3));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{format(shown)}</>;
}

/** "12 minutes ago", with the exact time on hover and to screen readers. */
export function RelativeTime({ iso, exact, now = Date.now() }: { iso: string; exact: string; now?: number }) {
  const text = ago(now - Date.parse(iso));
  return <Tooltip content={exact}><time dateTime={iso} title={exact} className="cursor-default">{text}</time></Tooltip>;
}

/** A small trend line in plain SVG: no chart library for eight points. */
export function Sparkline({ points, className, label }: { points: number[]; className?: string; label: string }) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const w = 80, h = 24;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - 2 - (p / max) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('h-6 w-20 overflow-visible text-primary', className)} role="img" aria-label={label}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A figure with its label, and optionally a trend. */
export function StatCard({ label, value, trend, tone, hint }: { label: string; value: number | null; trend?: number[]; tone?: 'danger'; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-xs">
      <p className="text-sm text-text-muted">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className={cn('text-xl font-semibold', tone === 'danger' && value ? 'text-danger' : '')}>{value === null ? <span className="text-text-muted">-</span> : <AnimatedNumber value={value} />}</p>
        {trend && <Sparkline points={trend} label={`${label}, recent trend`} />}
      </div>
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
