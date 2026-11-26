// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { VersionFooter } from '@/components/version-footer';
import { WayBack } from '@/components/way-back';

export const metadata: Metadata = { title: 'Page not found' };

/**
 * Any address the dashboard does not have (QA-1107-1): the dashboard's own card, one sentence, and the way back: to the
 * dashboard when signed in, to sign-in when not. Never the framework's bare 404.
 */
export default function NotFound() {
  return (
    <>
      <AuthCard title="Page not found">
        <p className="text-base text-text-muted">This page does not exist. It may have moved, or the link has a typo.</p>
        <WayBack />
      </AuthCard>
      {/* under /c/ the root layout's build line stands aside for the clinic pages' own: this page shows it instead */}
      <VersionFooter place="not-found" />
    </>
  );
}
