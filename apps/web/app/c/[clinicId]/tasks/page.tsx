// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/feedback';

/** Tasks are called Requests now. Old links and bookmarks land in the right place. */
export default function TasksMoved() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const router = useRouter();
  // with the query, so a filter in an old link (?status=done) still applies
  useEffect(() => { router.replace(`/c/${clinicId}/requests${window.location.search}`); }, [clinicId, router]);
  return <Skeleton className="h-64" />;
}
