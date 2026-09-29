# 6. The dashboard signs people in with Better Auth, and trusts nothing it does not check itself

**Status:** accepted, 2026-09-29

Staff see transcripts and refill requests, so the dashboard is the one place a stolen password turns into a PHI breach. We chose:

- **Better Auth** for passwords, sessions, organizations and TOTP two-factor, stored in our own Postgres (`auth_*` tables, migration 0002). No third-party identity service holds a session for a clinic. The application role has no grant on those tables.
- **Two-factor required** for every role before any clinic data is served. The only exception is demo mode, which is for synthetic data and says so on every page.
- **No sign-up.** An owner adds people (`pnpm add-member`); a stranger with the URL has nothing to sign up for.
- **Our own permission table.** Better Auth's organization plugin manages members; `apps/api/src/access.ts` decides what each role may see, and the guard checks it on every route. A viewer never sees a transcript.
- **One origin.** The web app proxies `/api`, so cookies stay first-party, and writes must also carry the dashboard's `Origin`. That covers cross-site requests without a separate CSRF token.
- **404 for other clinics.** A member of one clinic asking for another gets the same answer as for a clinic that does not exist.

- **Only the auth routes the dashboard uses are served.** Sign-in, sign-out, the session check and two-factor enrolment and verification. Better Auth's organization and account endpoints sit outside `StaffGuard`, so they would skip the two-factor rule; they answer 404 until the dashboard has member management of its own.
- **One client address.** Rate limits key on the address Fastify resolves (trusting exactly the dashboard's proxy hop), passed to Better Auth as the only forwarded value, so a header a browser sends cannot buy more password guesses.

A session ends 12 hours after sign-in however busy it is, and the dashboard signs out after 15 idle minutes and clears everything it had cached. Rate limits apply to every route, sign-in included. API responses are `Cache-Control: no-store`.

A demo deployment's logins use a password the operator sets (`ATTENDRA_DEMO_PASSWORD`, never printed or defaulted), and it cannot change transfer numbers, because a demo that takes real calls is on the internet. Only `pnpm demo`, which runs on one machine and forgets everything when it stops, shows its password on the sign-in page.

What we gave up, for now:

- Single sign-on (Google Workspace, Microsoft Entra). Better Auth supports it, and it is the first thing larger practices will ask for.
- A person who has not enrolled in two-factor yet signs in with the password alone and is taken straight to enrolment; until they finish, anyone with that password could enrol their own authenticator. Add people the day they start, and have them enrol at once. A one-time enrolment link from `add-member` closes this in a later version.
