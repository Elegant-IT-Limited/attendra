// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TextItem, TextList } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { StatusPill } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { shortWhen } from '@/lib/format';

/** What each text was, in the front desk's words. */
export const TEXT_TEMPLATES: Record<string, string> = {
  booking_confirmed: 'Booking confirmation',
  request_ready: 'Ready to pick up',
};

const REASONS: Record<string, string> = {
  opted_out: 'the number has opted out (replied STOP)',
  rate_limited: 'too many texts to that number today',
  no_number: 'no mobile number on file',
  texting_off: 'texting is off',
  unregistered: 'text registration (A2P) is not approved yet',
  carrier: 'the carrier refused it',
};

/** One line per text: a status, and what it was with when or why not. */
export function textLine(t: TextItem, timeZone: string): { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string; detail: string } {
  const what = TEXT_TEMPLATES[t.template] ?? t.template.replaceAll('_', ' ');
  const at = (iso: string | null) => (iso ? ` · ${shortWhen(iso, timeZone)}` : '');
  switch (t.status) {
    case 'delivered': return { tone: 'ok', label: 'Delivered', detail: `${what}${at(t.deliveredAt)}` };
    case 'sent': return { tone: 'ok', label: 'Sent', detail: `${what}${at(t.sentAt)} · delivery not reported yet` };
    case 'queued': return { tone: 'neutral', label: 'Sending', detail: what };
    case 'not_sent': return { tone: 'warn', label: 'Not sent', detail: `${what} · ${REASONS[t.failureReason ?? ''] ?? 'reason not recorded'}` };
    default: return { tone: 'danger', label: t.status === 'undelivered' ? 'Not delivered' : 'Failed', detail: `${what}${t.errorCode ? ` · carrier error ${t.errorCode}` : ''}` };
  }
}

/**
 * The texts about a call, a request, a pet or patient. Shows nothing while loading
 * and nothing when there are none, unless `empty` says what to show.
 */
export function TextStatus({ clinicId, filter, timeZone, empty, last4 = false }: {
  clinicId: string; filter: { callId?: string; taskId?: string; patientId?: string }; timeZone: string; empty?: string; last4?: boolean;
}) {
  const [key, value] = Object.entries(filter).find(([, v]) => !!v) ?? [];
  const texts = useQuery({
    queryKey: ['texts', clinicId, key, value],
    queryFn: () => api<TextList>(`/clinics/${clinicId}/texts?${key}=${encodeURIComponent(value ?? '')}`),
    enabled: !!key,
  });
  const rows = texts.data?.texts ?? [];
  if (!rows.length) return empty && texts.isSuccess ? <p className="text-sm text-text-muted">{empty}</p> : null;
  return (
    <ul className="space-y-1.5" aria-label="Texts">
      {rows.map((t) => {
        const line = textLine(t, timeZone);
        return (
          <li key={t.id} className="flex items-start gap-2 text-sm">
            <MessageSquare className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
            <span className="min-w-0">
              <StatusPill tone={line.tone} className="mr-1.5 align-middle">{line.label}</StatusPill>
              {line.detail}
              {last4 && t.toLast4 ? <span className="text-text-muted"> · to the number ending {t.toLast4}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
