// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TextItem, TextList } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { StatusPill } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { shortWhen } from '@/lib/format';
import { TEXT_KINDS, textKind, textStatusWords, textTone } from '@/lib/text-kinds';
import { useTerms } from '@/lib/terms';

/** What each text was: the one table of kinds (lib/text-kinds). */
export const TEXT_TEMPLATES: Record<string, string> = TEXT_KINDS;

/** One line per text: a status, and what it was with when or why not. */
export function textLine(t: TextItem, timeZone: string, provider = 'doctor'): { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string; detail: string } {
  const what = textKind(t.template, provider);
  const at = (iso: string | null) => (iso ? ` · ${shortWhen(iso, timeZone)}` : '');
  // the status in the same words as every text list ("Waiting", "Sent", "Delivered", "Not sent: <why>")
  const words = textStatusWords(t);
  const [label, why] = words.startsWith('Not sent: ') ? ['Not sent', words.slice('Not sent: '.length)] : [words, ''];
  const when = t.status === 'delivered' ? at(t.deliveredAt) : t.status === 'sent' ? `${at(t.sentAt)} · delivery not reported yet` : '';
  return { tone: textTone(t), label, detail: `${what}${when}${why ? ` · ${why}` : ''}` };
}

/**
 * The texts about a call, a request, a pet or patient. Shows nothing while loading
 * and nothing when there are none, unless `empty` says what to show.
 */
export function TextStatus({ clinicId, filter, timeZone, empty, last4 = false }: {
  clinicId: string; filter: { callId?: string; taskId?: string; patientId?: string; appointmentId?: string }; timeZone: string; empty?: string; last4?: boolean;
}) {
  const [key, value] = Object.entries(filter).find(([, v]) => !!v) ?? [];
  const terms = useTerms(clinicId);
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
        const line = textLine(t, timeZone, terms.provider);
        // a text asked for on the call: when the caller said yes, to find it in the transcript
        const yes = t.kind === 'asked' && t.consentAtMs !== null ? ` · asked for at ${Math.floor(t.consentAtMs / 60_000)}:${String(Math.floor((t.consentAtMs % 60_000) / 1000)).padStart(2, '0')} into the call` : '';
        return (
          <li key={t.id} className="flex items-start gap-2 text-sm">
            <MessageSquare className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
            <span className="min-w-0">
              <StatusPill tone={line.tone} className="mr-1.5 align-middle">{line.label}</StatusPill>
              {line.detail}{yes}
              {last4 && t.toLast4 ? <span className="text-text-muted"> · to the number ending {t.toLast4}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
