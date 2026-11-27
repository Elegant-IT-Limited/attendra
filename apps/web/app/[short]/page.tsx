// SPDX-License-Identifier: AGPL-3.0-only
import { notFound } from 'next/navigation';
import { ShortLink } from '@/components/short-link';
import { SHORT_PAGES } from '@/lib/short-links';

/**
 * The short addresses (QA-1109-2): /today, /calls, /schedule, /requests, /patients, /settings and the other main pages
 * open that page of the clinic last opened in this browser; signed out, after sign-in. Any other single word is the
 * dashboard's own "Page not found".
 */
export default async function Short({ params }: { params: Promise<{ short: string }> }) {
  const { short } = await params;
  if (!Object.hasOwn(SHORT_PAGES, short)) notFound();
  return <ShortLink short={short} />;
}
