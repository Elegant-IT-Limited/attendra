// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { useMe } from '@/lib/api';

/** Opens the first clinic the person belongs to. */
export default function Home() {
  const me = useMe();
  const router = useRouter();
  const first = me.data?.clinics[0];
  // a temporary password comes first, then two-step sign-in, then the clinic
  const mustChange = me.data?.user.mustChangePassword;
  useEffect(() => {
    if (mustChange) router.replace('/change-password');
    else if (first) router.replace(`/c/${first.id}`);
  }, [mustChange, first, router]);
  if (me.data && !first) {
    return <Empty title="No clinic yet">Your account is not a member of any clinic. Ask your practice owner to add you.</Empty>;
  }
  return <div className="mx-auto mt-24 max-w-sm space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /></div>;
}
