// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { GripVertical } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A list people put in order by dragging an item's handle, with a mouse or a finger,
 * or by focusing the handle and pressing the up and down arrow keys. Every list the
 * clinic orders (fields, choices, visit types, hospitals, links) uses this one, so it
 * works and looks the same everywhere. Each move is said aloud for screen readers.
 */
export function Sortable<T>({ items, keyOf, label, onMove, disabled, children, as = 'div', className, itemClassName }: {
  items: T[];
  keyOf: (item: T, index: number) => string;
  /** What an item is called, for the handle's name: "Insurer", "Front Range Pet Emergency". */
  label: (item: T, index: number) => string;
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
  /** The item, with its handle to place where it fits (usually first). */
  children: (item: T, index: number, handle: ReactNode) => ReactNode;
  as?: 'div' | 'ul';
  className?: string;
  itemClassName?: string;
}) {
  const list = useRef<HTMLElement | null>(null);
  const dragging = useRef<number | null>(null);
  const settling = useRef(false);
  const focusAfter = useRef<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [said, setSaid] = useState('');
  // a drag outlives renders: it reads the list as it is now, not as it was when it began
  const latest = useRef({ items, onMove, label });
  latest.current = { items, onMove, label };

  // once the list has re-rendered in its new order, the next pointer move may move again,
  // and a handle moved with the keyboard keeps the focus
  useEffect(() => {
    settling.current = false;
    if (focusAfter.current !== null) {
      list.current?.querySelector<HTMLElement>(`[data-sortable-handle="${focusAfter.current}"]`)?.focus();
      focusAfter.current = null;
    }
  }, [items]);

  const move = (from: number, to: number) => {
    const { items: now, onMove: change, label: name } = latest.current;
    if (to < 0 || to >= now.length || to === from) return false;
    change(from, to);
    setSaid(`${name(now[from]!, from) || 'The item'} moved to position ${to + 1} of ${now.length}.`);
    return true;
  };

  // the pointer is followed on the whole window, so a row moving under it never drops the drag
  const down = (e: PointerEvent<HTMLButtonElement>, i: number) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    dragging.current = i;
    setActive(i);
    const follow = (ev: globalThis.PointerEvent) => drag(ev.clientY);
    const stop = () => {
      window.removeEventListener('pointermove', follow);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      dragging.current = null;
      setActive(null);
    };
    window.addEventListener('pointermove', follow);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };
  const drag = (y: number) => {
    const from = dragging.current;
    if (from === null || settling.current || !list.current) return;
    const rows = [...list.current.querySelectorAll<HTMLElement>(':scope > [data-sortable-item]')];
    // the new place: how many of the other items have their middle above the pointer
    const to = rows.filter((row, j) => {
      if (j === from) return false;
      const r = row.getBoundingClientRect();
      return r.top + r.height / 2 < y;
    }).length;
    if (move(from, to)) { settling.current = true; dragging.current = to; setActive(to); }
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (disabled || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (move(i, to)) focusAfter.current = to;
  };

  const List = as;
  const Item = as === 'ul' ? 'li' : 'div';
  return (
    <>
      <List ref={(el: HTMLElement | null) => { list.current = el; }} className={className}>
        {items.map((item, i) => (
          <Item key={keyOf(item, i)} data-sortable-item={i}
            className={cn(itemClassName, active === i && 'relative z-10 rounded-lg shadow-lg ring-2 ring-primary/60')}>
            {children(item, i, items.length > 1 ? (
              <button type="button" data-sortable-handle={i} disabled={disabled}
                aria-label={`Move ${label(item, i) || 'this item'}: drag, or press the up and down arrow keys`}
                className={cn('focus-ring flex size-8 shrink-0 touch-none items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text disabled:pointer-events-none disabled:opacity-40',
                  active === i ? 'cursor-grabbing' : 'cursor-grab')}
                onPointerDown={(e) => down(e, i)}
                onKeyDown={(e) => key(e, i)}>
                <GripVertical className="size-4" aria-hidden />
              </button>
            ) : null)}
          </Item>
        ))}
      </List>
      <span className="sr-only" aria-live="polite">{said}</span>
    </>
  );
}

export { moved } from '@/lib/order';
