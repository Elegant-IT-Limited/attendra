# Test calls from the browser

Talk to a clinic's receptionist through your microphone, from the dashboard. It runs the same agent, tools, guardrails and settings as a phone call, and the call lands in the call list marked **Browser test**. You need an OpenAI API key with a few dollars of credit. You do not need a phone number, Twilio, a public URL or a webhook.

A test call costs what a phone call costs on OpenAI's side: GPT-Live is about $0.05 a minute, plus the backend model for tool steps. Calls end on their own after 5 minutes (`BROWSER_CALL_MAX_SECONDS`), and a clinic can have two open at once.

What the assistant does on a test call is real for that clinic: bookings, cancellations, refill and callback tasks all land where a phone call's would. Test calls never send texts. Try them on the demo clinic, whose patients are synthetic: say one of their names (Maria Delgado, born 4 March 1985, for example) to pass the identity check. On a live clinic, use a test patient.

## On your laptop

```bash
echo "OPENAI_API_KEY=sk-..." > .env     # at the repo root; .env is git-ignored
pnpm demo
```

Open http://localhost:3000, sign in as `frontdesk@maple-demo.test` (password `attendra-demo-password`), choose **Test call**, and allow the microphone. Headphones stop the assistant hearing itself.

`pnpm demo` starts the voice service in the same process when it finds the key, on 127.0.0.1:8080. Without a key everything else works and the Test call page says that calls are not set up.

## On a server

Both services need the same `VOICE_INTERNAL_TOKEN` (32 characters or more: `openssl rand -base64 32`), and the API needs `VOICE_URL`:

```bash
# .env
OPENAI_API_KEY=sk-...
VOICE_INTERNAL_TOKEN=...
VOICE_URL=http://voice:8080

docker compose -f infra/docker-compose.yml --profile voice up
```

Keep port 8080 private. The internal route only answers with the token, but nothing outside the host needs it; phone calls reach the voice service through OpenAI's webhook, which [live-call.md](live-call.md) puts behind HTTPS.

## How it works

1. The browser creates a WebRTC offer with a data channel and sends it to `POST /api/v1/clinics/:clinicId/test-calls`. The API checks the session, two-factor and the `calls:test` permission (owner, admin, front desk).
2. The API hands the offer to the voice service's internal route. The voice service loads the clinic's settings, creates the GPT-Live session with them (`client.live.create` with a WebRTC transport), records the call with channel `web` together with a `call.test.started` audit row naming the staff member, and attaches its sideband.
3. The browser applies OpenAI's answer. Audio then flows between the browser and OpenAI; it never passes through Attendra.
4. The voice service runs the call exactly as it runs a phone call: every tool, identity check and confirmation happens in the backend over the sideband.

The browser's data channel is limited to what a page needs: it may send `session.close` and receive the session start, the close and the live captions. It cannot add instructions or context, so a modified page cannot change what the assistant does.

The call ends when you press End, when the page is closed (the page asks the API to end it if it cannot say so itself), at the time limit, or when the voice service loses its sideband: a browser would otherwise keep talking to a model with no tools behind it.

A test call cannot be transferred, since there is no phone line to transfer. When the assistant would transfer, for an emergency or a caller asking for a person, it says the words, the transfer step is logged as failed, and the conversation goes on.
