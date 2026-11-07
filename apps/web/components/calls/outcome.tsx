// SPDX-License-Identifier: AGPL-3.0-only
import { Siren } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EMERGENCY_RESULTS, OUTCOMES } from '@/lib/format';

/** A call's outcome; an emergency says how it ended (put through, sent to the hospital, an urgent request), and one the caller cleared shows both. */
export function Outcome({ outcome, emergency, emergencyResult }: { outcome: string | null; emergency: boolean; emergencyResult?: string | null }) {
  const result = emergencyResult ? EMERGENCY_RESULTS[emergencyResult] : undefined;
  const o = OUTCOMES[outcome ?? ''] ?? { label: outcome ?? 'In progress', tone: 'neutral' as const };
  if (emergencyResult === 'cleared') return <span className="inline-flex flex-wrap gap-1"><Badge tone={o.tone}>{o.label}</Badge><Badge tone="warn"><Siren /> {result!.label}</Badge></span>;
  if (emergency) return <Badge tone="danger"><Siren /> {result?.label ?? 'Emergency'}</Badge>;
  return <Badge tone={o.tone}>{o.label}</Badge>;
}
