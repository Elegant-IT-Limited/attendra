// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type Announcements, closestCenter, DndContext, type DragEndEvent, type DragStartEvent, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Where a drag never starts: typing in a field, choosing in a list, or pressing a button stays what it is. */
const INTERACTIVE = 'input, textarea, select, option, button:not([data-sortable-handle]), a, label, [contenteditable="true"], [role="combobox"], [role="switch"], [role="checkbox"], [role="radio"]';
const fromInteractive = (target: EventTarget | null) => target instanceof Element && !!target.closest(INTERACTIVE);

/** A mouse drag starts anywhere on the card except a field or a button, after it moves 6 px. */
class CardMouseSensor extends MouseSensor {
  static override activators = [{
    eventName: 'onMouseDown' as const,
    handler: ({ nativeEvent: e }: { nativeEvent: MouseEvent }) => e.button === 0 && !fromInteractive(e.target),
  }];
}
/** A finger presses and holds a moment first, so the page still scrolls. */
class CardTouchSensor extends TouchSensor {
  static override activators = [{
    eventName: 'onTouchStart' as const,
    handler: ({ nativeEvent: e }: { nativeEvent: TouchEvent }) => !fromInteractive(e.target),
  }];
}

/**
 * A list people put in order by dragging: hold a card (anywhere but a field or a button,
 * or by its handle) and it lifts and follows the pointer, while the others slide aside to
 * show where it will land. A finger presses and holds first, so the page still scrolls.
 * With the keyboard, focus the handle and press the up and down arrow keys. Every list
 * the clinic orders uses this one, so it works and looks the same everywhere. Each move
 * is said aloud for screen readers.
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
  // this list's own handles: a list inside a card (a dropdown's choices) has handles of its own
  const listId = useId();
  const focusAfter = useRef<number | null>(null);
  const [said, setSaid] = useState('');
  const sensors = useSensors(
    useSensor(CardMouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(CardTouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
  );
  const ids = items.map((item, i) => keyOf(item, i));
  const indexOf = (id: string | number) => ids.indexOf(String(id));
  const name = (i: number) => (i >= 0 && items[i] !== undefined ? label(items[i]!, i) : '') || 'The item';

  // a handle moved with the keyboard keeps the focus once the list has its new order
  useEffect(() => {
    if (focusAfter.current === null) return;
    list.current?.querySelector<HTMLElement>(`[data-sortable-handle="${listId}:${focusAfter.current}"]`)?.focus();
    focusAfter.current = null;
  }, [items]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || to === from) return false;
    onMove(from, to);
    setSaid(`${name(from)} moved to position ${to + 1} of ${items.length}.`);
    return true;
  };
  const end = ({ active, over }: DragEndEvent) => {
    if (over) move(indexOf(active.id), indexOf(over.id));
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (disabled || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (move(i, to)) focusAfter.current = to;
  };
  // what a screen reader hears while a card is dragged with the pointer
  const announcements: Announcements = {
    onDragStart: ({ active }: Pick<DragStartEvent, 'active'>) => `Picked up ${name(indexOf(active.id))}.`,
    onDragOver: ({ over }) => (over ? `Over position ${indexOf(over.id) + 1} of ${items.length}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `${name(indexOf(active.id))} dropped at position ${indexOf(over.id) + 1} of ${items.length}.` : undefined),
    onDragCancel: ({ active }) => `${name(indexOf(active.id))} put back.`,
  };

  const List = as;
  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={end} accessibility={{ announcements }}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={disabled || items.length < 2}>
          <List ref={(el: HTMLElement | null) => { list.current = el; }} className={className}>
            {items.map((item, i) => (
              <Row key={ids[i]} id={ids[i]!} index={i} handleKey={`${listId}:${i}`} as={as === 'ul' ? 'li' : 'div'} className={itemClassName} disabled={disabled || items.length < 2}
                handleLabel={`Move ${label(item, i) || 'this item'}: drag the card, or press the up and down arrow keys`}
                onKey={(e) => key(e, i)} render={(handle) => children(item, i, items.length > 1 ? handle : null)} />
            ))}
          </List>
        </SortableContext>
      </DndContext>
      <span className="sr-only" aria-live="polite">{said}</span>
    </>
  );
}

/** One card: it follows the pointer while dragged, lifted above the rest; the others slide aside. */
function Row({ id, index, handleKey, as: Item, className, disabled, handleLabel, onKey, render }: {
  id: string;
  index: number;
  handleKey: string;
  as: 'li' | 'div';
  className?: string;
  disabled?: boolean;
  handleLabel: string;
  onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
  render: (handle: ReactNode) => ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled });
  const handle = (
    <button type="button" ref={setActivatorNodeRef} data-sortable-handle={handleKey} disabled={disabled} aria-label={handleLabel}
      className={cn('focus-ring flex size-8 shrink-0 touch-none items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text disabled:pointer-events-none disabled:opacity-40',
        isDragging ? 'cursor-grabbing' : 'cursor-grab')}
      onKeyDown={onKey}>
      <GripVertical className="size-4" aria-hidden />
    </button>
  );
  return (
    <Item ref={setNodeRef} data-sortable-item={index} {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(className, isDragging && 'relative z-20 cursor-grabbing rounded-lg bg-surface shadow-xl ring-2 ring-primary/60')}>
      {render(handle)}
    </Item>
  );
}

export { moved } from '@/lib/order';
