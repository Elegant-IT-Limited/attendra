// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AcceptedInvitation, MyInvitationList } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useProblem } from '@/components/ui/toast';
import { api, ApiFailure, saveProblem, useMe } from '@/lib/api';
import { invitationLine } from '@/lib/invitations';
import { cn } from '@/lib/utils';

/**
 * "Maple Street invited you as Front desk", with Accept and Decline, on every page while an
 * invitation waits, and on the start and profile pages of someone with no clinic yet. An
 * "every location" invitation is one line and one Accept. Accepting opens the clinic, which
 * is in the clinic switcher from then on; nothing changes at the person's other clinics.
 */
export function InvitationsBanner({ inline = false }: { inline?: boolean }) {
  const router = useRouter();
  const queries = useQueryClient();
  const problem = useProblem();
  const me = useMe();
  const invitations = useQuery({ queryKey: ['me', 'invitations'], queryFn: () => api<MyInvitationList>('/me/invitations'), staleTime: 60_000, refetchInterval: 5 * 60_000 });
  const answer = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => api<AcceptedInvitation | undefined>(`/me/invitations/${id}/${accept ? 'accept' : 'decline'}`, { method: 'POST' }),
    onSuccess: async (r) => {
      await queries.invalidateQueries({ queryKey: ['me'] });
      if (r?.clinicId) router.push(`/c/${r.clinicId}`);
    },
    onError: (e) => {
      problem({ title: 'Not answered', message: e instanceof ApiFailure && e.body.message ? e.body.message : saveProblem(e).replace(/^Not saved/, 'Not answered') });
      void queries.invalidateQueries({ queryKey: ['me', 'invitations'] });
    },
  });
  if (!invitations.data?.invitations.length) return null;
  return (
    <>
      {invitations.data.invitations.map((i) => (
        <div key={i.id} role="status" data-testid="invitation"
          className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 bg-info-soft text-sm', inline ? 'rounded-lg px-4 py-3' : 'border-b border-border px-6 py-2')}>
          <span className="min-w-0 flex-1">{invitationLine(i, me.data?.roles)}</span>
          <span className="flex gap-2">
            <Button size="sm" disabled={answer.isPending} onClick={() => answer.mutate({ id: i.id, accept: true })}>Accept</Button>
            <Button size="sm" variant="ghost" disabled={answer.isPending} onClick={() => answer.mutate({ id: i.id, accept: false })}>Decline</Button>
          </span>
        </div>
      ))}
    </>
  );
}
