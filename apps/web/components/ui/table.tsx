// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** A data table. The header stays put while the rows scroll; `density` trades air for rows. */
export function Table({ className, density = 'comfortable', ...props }: HTMLAttributes<HTMLTableElement> & { density?: 'compact' | 'comfortable' }) {
  return (
    <div className="overflow-x-auto" data-density={density}>
      <table className={cn('group/table w-full text-base', className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('sticky top-0 z-10 border-b border-border bg-surface text-left text-xs font-medium tracking-wide text-text-muted uppercase', className)} {...props} />;
}
export function TRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-border transition-colors last:border-0 [tbody_&]:hover:bg-surface-sunken/60', className)} {...props} />;
}
export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('px-4 py-2.5 font-medium', className)} {...props} />;
}
export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3 align-middle group-data-[density=compact]/table:py-2 [[data-density=compact]_&]:py-2', className)} {...props} />;
}

/** A column heading that sorts. `sort` is this column's direction, or null when another column sorts. */
export function SortTH({ children, sort, onSort, className }: { children: React.ReactNode; sort: 'asc' | 'desc' | null; onSort: () => void; className?: string }) {
  const Icon = sort === 'asc' ? ArrowUp : sort === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <TH className={className} aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : 'none'}>
      <button type="button" onClick={onSort} className="focus-ring -mx-1 inline-flex items-center gap-1 rounded-sm px-1 uppercase hover:text-text">
        {children}<Icon className={cn('size-3', !sort && 'opacity-40')} aria-hidden />
      </button>
    </TH>
  );
}
