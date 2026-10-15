// SPDX-License-Identifier: AGPL-3.0-only
import type { NextConfig } from 'next';

// The dashboard and the API share one origin: the browser talks to /api here and
// Next forwards it, so the session cookie stays first-party and SameSite=Lax holds.
const api = process.env.API_URL ?? 'http://127.0.0.1:8081';
// Set to try a hosting layer locally (attendra-cloud on :3100); in production a reverse proxy does this.
const account = process.env.ATTENDRA_ACCOUNT_URL;

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  transpilePackages: ['@attendra/core'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      // a hosting layer's account pages (sign-up, billing), on this same address so they share the session
      ...(account ? [{ source: '/account', destination: `${account}/account` }, { source: '/account/:path*', destination: `${account}/account/:path*` }] : []),
    ];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        // The microphone is for the test call page. The policy applies to the document
        // the app loaded in, and the app moves between pages without reloading, so it
        // is allowed for this origin rather than for one path. Frames never get it.
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
      ],
    }];
  },
};

export default config;
