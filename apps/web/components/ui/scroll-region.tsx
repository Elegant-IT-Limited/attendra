// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type HTMLAttributes, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A box that scrolls sideways when what it holds is wider than the screen: a table on a phone,
 * the Settings tabs. While it scrolls it takes the keyboard's focus, so the arrow keys move it
 * (axe: scrollable-region-focusable), it is a named region for a screen reader, and a shadow on
 * the edge with more behind it shows that there is more.
 */
export function ScrollRegion({ label, className, children, ...props }: HTMLAttributes<HTMLDivElement> & { label: string }) {
  const box = useRef<HTMLDivElement>(null);
  // whether there is more to the left and to the right of what shows
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    for (const child of el.children) watch.observe(child);
    return () => { el.removeEventListener('scroll', measure); watch.disconnect(); };
  }, []);
  const scrolls = more.left || more.right;
  const edge = 'pointer-events-none absolute inset-y-0 w-8 from-text/20 to-transparent opacity-0 transition-opacity';
  return (
    <div className={cn('relative', className)}>
      <div ref={box} role="region" aria-label={label} tabIndex={scrolls ? 0 : undefined} className="focus-ring overflow-x-auto" {...props}>{children}</div>
      <div aria-hidden className={cn(edge, 'left-0 bg-gradient-to-r', more.left && 'opacity-100')} data-testid="scroll-edge-left" />
      <div aria-hidden className={cn(edge, 'right-0 bg-gradient-to-l', more.right && 'opacity-100')} data-testid="scroll-edge-right" />
    </div>
  );
}
