# A live call on a small server

This takes a fresh Linux server to a real phone number that the demo clinic answers, with the dashboard showing the call a few seconds after you hang up. Plan on about an hour, most of it waiting for DNS and Twilio.

Everything here uses the synthetic demo clinic. Do not route real patients to it: demo mode turns off two-step sign-in, and none of the BAAs in [hipaa.md](hipaa.md) are in place. Transfer numbers are locked in demo mode, so nobody who signs in can send calls somewhere new.

## What you need

- A server with 2 GB of RAM, Ubuntu 24.04, a public IP and ports 80 and 443 open. Any provider works; keep it separate from servers that hold anything else.
- A domain name you can add a DNS record to, for example `attendra-demo.example.com`.
- An OpenAI project with GPT-Live SIP enabled, and an API key for it.
- A Twilio account with one voice-capable US number.

Voice is billed per second: GPT-Live is $0.05 a minute, plus the backend model's tokens and Twilio's per-minute rate. A ten-minute test session costs well under a dollar.

## 1. DNS and the server

Point an `A` record for your domain at the server's IP. Then, on the server:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo apt-get install -y caddy git
git clone https://github.com/Elegant-IT-Limited/attendra.git && cd attendra
```

Caddy terminates HTTPS and gets the certificate by itself. Replace the domain in `/etc/caddy/Caddyfile` with yours:

```caddy
attendra-demo.example.com {
  reverse_proxy /webhooks/* 127.0.0.1:8080
  reverse_proxy 127.0.0.1:3000
}
```

`sudo systemctl reload caddy`. The voice webhook and the dashboard now share one HTTPS address.

## 2. OpenAI

1. In the project settings, create a webhook for the event `live.transport.incoming` at `https://attendra-demo.example.com/webhooks/openai`. Copy the signing secret (`whsec_...`).
2. Note the project id. Calls reach it at `sip:<project-id>@sip.api.openai.com;transport=tls`.

## 3. Twilio

1. Create an Elastic SIP Trunk. Under **Origination**, add `sip:<project-id>@sip.api.openai.com;transport=tls`. Turn on secure trunking.
2. In the number's voice configuration, choose the trunk.
3. Texts need A2P 10DLC registration before they reach US mobiles. Calls work without it; booking confirmations fail quietly until it is done, and the call record shows the failed send.

## 4. Configure and start

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Value |
|---|---|
| `ATTENDRA_DATA_KEY` | `openssl rand -base64 32` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET` | from step 2 |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | from the Twilio console |
| `PUBLIC_URL` | `https://attendra-demo.example.com` |
| `ATTENDRA_DEMO_MODE` | `true` |

Then:

```bash
sudo docker compose -f infra/docker-compose.yml --profile voice up -d --build
sudo docker compose -f infra/docker-compose.yml exec api pnpm db:add-number --clinic clinic_demo_maple --number +1XXXXXXXXXX
```

The second command points your Twilio number at the demo clinic and makes it the number confirmations are sent from.

## 5. Call it

1. Get the demo password the seed printed: `sudo docker compose -f infra/docker-compose.yml logs seed`. (Set `ATTENDRA_DEMO_PASSWORD` in `.env` before the first start if you would rather choose it.) Open `https://attendra-demo.example.com` and sign in as `manager@maple-demo.test`. You see the week of recorded demo calls.
2. Call your Twilio number. The assistant greets you as Maple Street Family Medicine and says it is an AI assistant.
3. Try it as Maria Delgado, born March 4, 1985: ask for a sick visit, pick a time, say yes. Or ask whether they take Cigna. Or say you have chest pain.
4. Hang up. The call is at the top of **Calls** with its transcript, and any refill or callback is under **Tasks**.

## When something is off

- `sudo docker compose -f infra/docker-compose.yml logs voice` shows each webhook and call, never the caller's words.
- No webhook arriving: check the URL in the OpenAI project and that `https://<domain>/webhooks/openai` answers (a `400 invalid signature` to a plain `curl -X POST` means it is reachable).
- The call rings but is not answered: the number is not in `phone_numbers`. Run the `db:add-number` command again.
- The call drops right after the greeting: check `OPENAI_API_KEY` belongs to the same project as the SIP URI.
