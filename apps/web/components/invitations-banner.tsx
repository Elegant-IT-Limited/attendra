// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AcceptedInvitation, MyInvitationList } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useProblem } from '@/components/ui/toast';
import { api, ApiFailure } from '@/lib/api';

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Practice manager', staff: 'Front desk', viewer: 'Viewer' };

/**
 * "Maple Street invited you to its team as Front desk", with Accept and Decline, on every
 * page while an invitation waits. Accepting opens the clinic, which is in the clinic
 * switcher from then on; nothing changes at the person's other clinics.
 */
export function InvitationsBanner() {
  const router = useRouter();
  const queries = useQueryClient();
  const problem = useProblem();
  const invitations = useQuery({ queryKey: ['me', 'invitations'], queryFn: () => api<MyInvitationList>('/me/invitations'), staleTime: 5 * 60_000, refetchInterval: 5 * 60_000 });
  const answer = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => api<AcceptedInvitation | undefined>(`/me/invitations/${id}/${accept ? 'accept' : 'decline'}`, { method: 'POST' }),
    onSuccess: async (r) => {
      await queries.invalidateQueries({ queryKey: ['me'] });
      if (r?.clinicId) router.push(`/c/${r.clinicId}`);
    },
    onError: (e) => {
      problem({ title: 'Not answered', message: e instanceof ApiFailure && e.body.message ? e.body.message : 'That did not go through. Check your connection and try again.' });
      void queries.invalidateQueries({ queryKey: ['me', 'invitations'] });
    },
  });
  if (!invitations.data?.invitations.length) return null;
  return (
    <>
      {invitations.data.invitations.map((i) => (
        <div key={i.id} role="status" data-testid="invitation" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-info-soft px-6 py-2 text-sm">
          <span className="min-w-0 flex-1">{i.clinicName} invited you to its team as {ROLE_LABEL[i.role] ?? i.role}.</span>
          <span className="flex gap-2">
            <Button size="sm" disabled={answer.isPending} onClick={() => answer.mutate({ id: i.id, accept: true })}>Accept</Button>
            <Button size="sm" variant="ghost" disabled={answer.isPending} onClick={() => answer.mutate({ id: i.id, accept: false })}>Decline</Button>
          </span>
        </div>
      ))}
    </>
  );
}
