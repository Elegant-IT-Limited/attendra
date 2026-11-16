// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState } from 'react';
import { Section } from '@/components/settings/section';
import { Segmented } from '@/components/ui/tabs';
import { TextHistory } from './text-history';

/**
 * Settings > Texting, "Recent texts" (text history, 2026-11-16): the clinic's newest 50 texts, all or only those not
 * sent, read-only. Each with when, kind, where it is, the words that went out, the pet and what it belongs to.
 */
export function RecentTexts({ clinicId, timeZone }: { clinicId: string; timeZone: string }) {
  const [status, setStatus] = useState<'all' | 'not_sent'>('all');
  return (
    <Section id="recent-texts" title="Recent texts" description="The newest 50 texts your clinic sent, and where each one is. The words are kept as long as your call records.">
      <Segmented label="Which texts" value={status} onValueChange={setStatus} className="mb-3"
        options={[{ value: 'all', label: 'All' }, { value: 'not_sent', label: 'Not sent' }]} />
      <div className="-mx-5 border-t border-border">
        <TextHistory clinicId={clinicId} timeZone={timeZone} query={{ recent: true, status }}
          empty={status === 'not_sent' ? 'Every recent text was sent.' : 'No texts sent yet.'} />
      </div>
    </Section>
  );
}
