// SPDX-License-Identifier: AGPL-3.0-only
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [twoFactorClient({ onTwoFactorRedirect: () => { window.location.href = '/two-factor'; } })],
});
