# Self-hosting

This guide takes a fresh checkout to a phone number that answers. Use synthetic data until the steps in [hipaa.md](hipaa.md) are done.

## 1. OpenAI

1. Use a project with GPT-Live and SIP support enabled.
2. Create a webhook endpoint for `live.transport.incoming`, pointing at `https://<your-host>/webhooks/openai`. Keep the signing secret (`whsec_...`) for `OPENAI_WEBHOOK_SECRET`.
3. Note the project id: the SIP URI is `sip:<project-id>@sip.api.openai.com;transport=tls`.

## 2. Twilio

1. Buy or port a number for the clinic.
2. Create an Elastic SIP Trunk. Under **Origination**, add the OpenAI SIP URI above as the origination URI. Enable secure trunking (TLS and SRTP).
3. Point the number's voice configuration at the trunk.
4. For SMS confirmations, register the number for A2P 10DLC before sending to US mobiles.

Twilio's walkthrough of the same trunk setup: <https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking>.

## 3. Run it

```bash
cp .env.example .env     # OpenAI, Twilio, ATTENDRA_DATA_KEY and BETTER_AUTH_SECRET (openssl rand -base64 32 for each), PUBLIC_URL
docker compose -f infra/docker-compose.yml --profile voice up -d --build
```

Compose starts Postgres, applies the migrations, loads the demo clinic ("Maple Street Family Medicine") and starts the dashboard API, the worker, the dashboard on port 3000 and the voice service on port 8080. The worker creates pg-boss's own schema (`pgboss`) in the same database the first time it starts, so its login role needs `create` on the database; it needs no other service and no Redis. Run one worker or several; pg-boss hands each job to one of them. Put both behind HTTPS on one address: `/webhooks/*` to the voice service, everything else to the dashboard. [live-call.md](live-call.md) has a Caddy example.

Optional services, each off until you want it: `--profile voice` for calls, `--profile mcp` for other AI agents over MCP ([mcp.md](mcp.md)). The worker always runs.

**New in v0.4, in `.env`:** `ATTENDRA_SUMMARY_MODEL` (call summaries), `ATTENDRA_EMBEDDING_MODEL` (the clinic's documents, the same value for the worker, voice and API), `ATTENDRA_SMS_STATUS` (off until Twilio sends statuses), `ATTENDRA_JUDGE_MODEL` and `ATTENDRA_SIM_MODEL` (quality tools you run by hand), and `MCP_PORT` (MCP; the stdio bridge takes its URL and key in the desktop client's config). `.env.example` explains each one. Without `OPENAI_API_KEY` the worker still runs: summaries are written from each call's facts, and documents are embedded locally.

Then add yourself and point your number at the clinic:

```bash
docker compose -f infra/docker-compose.yml exec -e ATTENDRA_NEW_PASSWORD='a long passphrase' api \
  pnpm add-member --email you@clinic.example --name "Your Name" --org org_demo --role owner
docker compose -f infra/docker-compose.yml exec api pnpm db:add-number --clinic clinic_demo_maple --number +1XXXXXXXXXX
```

At first sign-in the dashboard asks you to set up two-step sign-in with an authenticator app.

**Upgrading an install that ran `postgres:16`.** v0.4 needs the pgvector extension for the clinic's knowledge. The `pgvector/pgvector:pg16` image is Postgres 16 with pgvector added, and reads the same data directory, so the upgrade is a new image and nothing else:

```bash
docker compose -f infra/docker-compose.yml down        # keeps the pgdata volume
git pull                                               # compose now names pgvector/pgvector:pg16
docker compose -f infra/docker-compose.yml up -d --build
```

The `migrate` service then creates the extension (`create extension if not exists vector`) in migration `0011_knowledge.sql`. Back up first, as for any upgrade: `docker compose exec postgres pg_dump -U attendra attendra > attendra.sql`.

**Upgrading to v0.4.1.** Patient names are now compared with letters such as ø, ł, æ and ß spelled with their base letters, so a patient's lookup hash has to be recomputed once, with the same `ATTENDRA_DATA_KEY` the services use: `DATABASE_URL=... ATTENDRA_DATA_KEY=... pnpm db:rehash-lookups`. It only rewrites hashes that change, and can be run again safely. Until it has run, patients whose names use those letters, or letters outside the Latin alphabet, cannot be verified on a call.

Using your own Postgres instead of Compose? It needs the pgvector extension installed (the `postgresql-16-pgvector` package on Debian and Ubuntu, or your provider's pgvector option); the migration enables it. Run the migrations as the database owner, and let the service's login role switch into the application role the RLS policies are written for:

```sql
grant attendra_app to <your_service_user>;
```

## 4. Check it

- `GET /healthz` on the voice service and `GET /api/v1/health` on the dashboard return `ok: true`.
- A call to the number is answered with the demo greeting. The service logs `call accepted` with the session id; no caller details appear in the log.
- After the call, it is at the top of **Calls** in the dashboard with its transcript, outcome and length, and within a few seconds its summary. If the summary never comes, check the worker's log: a job that failed every retry is logged with its ids as `dead-lettered`.

## Configuring your clinic

A clinic is one validated JSON document (`ClinicConfig` in `packages/core/src/clinic.ts`): time zone, weekly hours, holidays, providers with their own hours and visit types, routing rules for transfers, the FAQ, the greeting, the voice, and whether emergency transfer is on. Invalid config is refused at load, with the field that failed. A practice manager edits all of it under **Settings** in the dashboard, where the same validation runs before anything is saved; phone numbers stay with the operator (`pnpm db:add-number`).
