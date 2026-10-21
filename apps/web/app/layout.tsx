// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { THEME_SCRIPT } from '@/lib/theme-script';
import './globals.css';
import { Providers } from './providers';

// Self-hosted from this app, never from a font CDN: Geist, the website's typeface, under the SIL Open Font License.
const geist = localFont({ src: './fonts/geist-latin-var.woff2', variable: '--font-geist', weight: '100 900', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Attendra', template: '%s · Attendra' },
  description: 'The front-desk dashboard for the Attendra AI receptionist.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#faf7f1' }, { media: '(prefers-color-scheme: dark)', color: '#1a1714' }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // the theme script sets data-theme before React runs, so the server's markup differs from the first paint on purpose
    <html lang="en" className={geist.variable} suppressHydrationWarning>
      <head>
        {/* before first paint: the chosen theme, so a dark screen never flashes white */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
