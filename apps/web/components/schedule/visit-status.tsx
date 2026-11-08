// SPDX-License-Identifier: AGPL-3.0-only
import { VISIT_STATUS_LABELS, type VisitStatus } from '@attendra/core';
import { CheckCheck, UserCheck, UserX } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** What the desk marked a visit, with the same words everywhere (core VISIT_STATUS_LABELS). */
export const MARKED: Partial<Record<VisitStatus, { Icon: typeof UserCheck; tone: BadgeTone }>> = {
  arrived: { Icon: UserCheck, tone: 'info' },
  completed: { Icon: CheckCheck, tone: 'ok' },
  no_show: { Icon: UserX, tone: 'warn' },
};

/** ", arrived" for a screen reader's label of a block or a row; nothing for booked or cancelled (said elsewhere). */
export const markedWords = (status: string) => (MARKED[status as VisitStatus] ? `, ${VISIT_STATUS_LABELS[status as VisitStatus].toLowerCase()}` : '');

/** The small icon on a schedule block for a visit the desk marked; nothing for booked or cancelled. */
export function MarkedIcon({ status, className }: { status: string; className?: string }) {
  const m = MARKED[status as VisitStatus];
  if (!m) return null;
  return <m.Icon className={cn('inline size-3 shrink-0', status === 'no_show' ? 'text-warning' : status === 'completed' ? 'text-success' : 'text-info', className)} aria-hidden data-testid={`marked-${status}`} />;
}

/** The badge for a marked visit; nothing for booked or cancelled. */
export function MarkedBadge({ status }: { status: string }) {
  const m = MARKED[status as VisitStatus];
  if (!m) return null;
  return <Badge tone={m.tone} data-testid="visit-status"><m.Icon aria-hidden /> {VISIT_STATUS_LABELS[status as VisitStatus]}</Badge>;
}
