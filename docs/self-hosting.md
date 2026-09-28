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
cp .env.example .env     # fill in OpenAI, Twilio and ATTENDRA_DATA_KEY (openssl rand -base64 32)
docker compose -f infra/docker-compose.yml up
```

Compose starts Postgres, applies the migrations, loads the demo clinic ("Maple Street Family Medicine", `+13035550100`) and starts the voice service on port 8080. Expose it over HTTPS (a reverse proxy or a tunnel) at the URL you gave OpenAI.

Using your own Postgres instead of Compose? Run the migrations as the database owner, and let the service's login role switch into the application role the RLS policies are written for:

```sql
grant attendra_app to <your_service_user>;
```

To make your own number reach the demo clinic, add it to the clinic's `phoneNumbers` in `packages/core/src/demo.ts` and run `pnpm db:seed` again, or insert it into `phone_numbers`.

## 4. Check it

- `GET /healthz` returns `{ "ok": true }`.
- A call to the number is answered with the demo greeting. The service logs `call accepted` with the session id; no caller details appear in the log.
- After the call, the `calls` row has `close_reason`, `voice_seconds` and an `outcome`.

## Configuring your clinic

A clinic is one validated JSON document (`ClinicConfig` in `packages/core/src/clinic.ts`): time zone, weekly hours, holidays, providers with their own hours and visit types, routing rules for transfers, the FAQ, the greeting, the voice, and whether emergency transfer is on. Invalid config is refused at load, with the field that failed.
