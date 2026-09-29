// SPDX-License-Identifier: AGPL-3.0-only
import { Siren } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { OUTCOMES } from '@/lib/format';

export function Outcome({ outcome, emergency }: { outcome: string | null; emergency: boolean }) {
  if (emergency) return <Badge tone="danger"><Siren /> Emergency</Badge>;
  const o = OUTCOMES[outcome ?? ''] ?? { label: outcome ?? 'In progress', tone: 'neutral' as const };
  return <Badge tone={o.tone}>{o.label}</Badge>;
}
