# Webhooks

Attendra tells your other systems when something happens at the clinic: a call ended, a booking was made, a request came in. Connect n8n, Zapier, Make, or anything that can receive an HTTPS POST. Owners and practice managers set this up under **Settings > Integrations**.

## What you receive

Every delivery is a POST with a JSON body and three headers, following the [Standard Webhooks](https://www.standardwebhooks.com/) specification:

| Header | What it is |
|---|---|
| `webhook-id` | The event's id, like `evt_3f9c...`. The same event redelivered keeps its id, so use it to ignore repeats. |
| `webhook-timestamp` | When this delivery was signed, in Unix seconds. |
| `webhook-signature` | `v1,` and a base64 HMAC-SHA256 of `id.timestamp.body` with your endpoint's secret. During a secret rotation there are two, separated by a space. |

The body is always the same shape. This endpoint leaves patient ids out, as endpoints do by default:

```json
{
  "type": "appointment.booked",
  "timestamp": "2026-09-30T15:04:05.000Z",
  "data": {
    "clinicId": "clinic_demo_maple",
    "appointmentId": "7b1f4c9e-2d7a-4f1e-9a53-0c1f8e2b6d10",
    "providerId": "prov_okafor",
    "visitTypeId": "vt_sick",
    "startsAt": "2026-10-06T15:00:00.000Z",
    "endsAt": "2026-10-06T15:20:00.000Z",
    "by": "assistant",
    "callId": "5d3a1e7c-8b2f-4d6a-9c1e-3f7b2a8d4e60"
  }
}
```

## As little patient data as possible

Payloads carry **ids, times, types, outcomes and counts, and nothing else**: never a name, a phone number, a date of birth, what was said on a call, a summary, or a note. A webhook goes to a system Attendra cannot audit, over the internet, so it gets only what it needs to know that something happened. When a receiver needs the details, it fetches them through the Attendra API, as someone allowed to see them, and that read is audited like any other.

That is not the same as no PHI. A patient id with an appointment's times says who is seen when, and HIPAA treats it as PHI. So each endpoint has **Leave out patient ids**, on by default: `patientId` is dropped from every delivery to it. Turn it off only for a receiver that needs to tell patients apart and is covered by a BAA. Even with patient ids left out, a delivery tells the receiver that the clinic booked someone at a given time, so whoever runs the receiver, and any automation service in between (n8n cloud, Zapier, Make), needs a BAA before the endpoint is used with real patients ([hipaa.md](hipaa.md)).

## Events

| Event | When | Data |
|---|---|---|
| `call.completed` | A call ends. | `callId`, `channel` (`phone` or `web` for a browser test), `startedAt`, `endedAt`, `durationSeconds`, `outcome` (`booked`, `rescheduled`, `cancelled`, `task_created`, `transferred`, `emergency`, `abandoned`), `emergency`, `verified` |
| `call.summary.ready` | The worker has summarised a call. | `callId`, `intent`, `sentiment`, `needsReview`. The summary itself stays in Attendra. |
| `appointment.booked` | The assistant or the front desk books. | `appointmentId`, `patientId` (unless the endpoint leaves patient ids out), `providerId`, `visitTypeId`, `startsAt`, `endsAt`, `by` (`assistant` or `staff`), `callId` |
| `appointment.rescheduled` | An appointment moves. | As booked, plus `previousAppointmentId` when the assistant booked a new one in its place (the front desk moves it in place, so that is `null`). |
| `appointment.cancelled` | An appointment is cancelled. | `appointmentId`, `patientId` (unless the endpoint leaves patient ids out), `by`, `callId`, `reason` (a code, like `patient_asked`) |
| `request.created` | The assistant takes a refill or callback request. | `requestId`, `type` (`refill`, `callback`), `patientId` or `null` (left out when the endpoint leaves patient ids out), `callId` |
| `request.done` | Staff close a request. | `requestId`, `type`, `outcome` (`called_back`, `left_message`, `refill_sent`, `not_needed`), `callId` |

**Send test event** delivers a `webhook.test` event with `endpointId` and `test: true`, so you can build and check a receiver before anything real happens.

## Checking a delivery

Check the signature, in constant time, and reject a timestamp more than five minutes away, so an old delivery cannot be replayed. Use the raw body as it arrived: parsing and re-serialising the JSON changes the bytes.

TypeScript (Node):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyAttendra(secret: string, headers: Record<string, string>, rawBody: string, toleranceSeconds = 300): boolean {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (!id || !timestamp || !signatures) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false; // too old: a replay
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from(`v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`);
  return signatures.split(' ').some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
}
```

Python:

```python
import base64, hashlib, hmac, time

def verify_attendra(secret: str, headers: dict, body: bytes, tolerance: int = 300) -> bool:
    msg_id = headers.get("webhook-id")
    timestamp = headers.get("webhook-timestamp")
    signatures = headers.get("webhook-signature")
    if not (msg_id and timestamp and signatures):
        return False
    if abs(time.time() - int(timestamp)) > tolerance:
        return False  # too old: a replay
    key = base64.b64decode(secret.removeprefix("whsec_"))
    signed = f"{msg_id}.{timestamp}.".encode() + body
    expected = "v1," + base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    return any(hmac.compare_digest(expected, s) for s in signatures.split(" "))
```

Both check the Standard Webhooks reference example, and the Standard Webhooks libraries for other languages work too.

## Retries, and turning an endpoint off

A delivery succeeds on any `2xx` answer within 10 seconds. Anything else is retried, backing off from a minute to four hours, twelve times: about a day of trying. Redirects are not followed. Every attempt is in the endpoint's delivery log with its status code and how long it took, and any of them can be sent again from there with **Redeliver**.

If an endpoint fails three events in a row, each after its day of retries, Attendra turns it off, records that in the audit log, and tells owners and managers on **Today** and on the Integrations page. Fix the receiver and turn it back on; its failure count starts again.

## Which addresses are allowed

Only public `https://` addresses. Attendra refuses this machine, private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, IPv6 unique local and link-local), cloud metadata addresses (`169.254.169.254`, `metadata.google.internal`), and names like `localhost` or `*.internal`. The address is checked when you save the endpoint and again at every delivery, after DNS resolution, and the delivery connects to the address that was checked, so a name whose answer changes in between still cannot reach an internal service. A URL with a user name or password in it is refused; put credentials in your receiver's own settings instead.

For trying n8n on your own computer, the local demo can deliver to this machine over plain HTTP: `ATTENDRA_WEBHOOKS_ALLOW_LOCAL=on pnpm demo`. Never set it on a deployment.

## Secrets

Each endpoint has its own secret, shown once, when you add the endpoint. Attendra keeps it encrypted. **Rotate secret** makes a new one, shown once; for 24 hours every delivery carries both signatures, so you can update the receiver without dropping a delivery.

## Recipe: n8n

1. In n8n, add a **Webhook** node. Method `POST`, respond **Immediately**, and under options turn on **Raw Body**, so the signature can be checked against the exact bytes. Copy its production URL.
2. In Attendra, **Settings > Integrations > Add an endpoint**: paste the URL, tick `appointment.booked` and `request.created`, and add it. Copy the secret, and store it in n8n as a credential or an environment variable (`ATTENDRA_WEBHOOK_SECRET`).
3. After the Webhook node, add a **Code** node (mode: Run Once for All Items) that checks the signature and stops anything that fails. n8n keeps Node's built-in modules out of the Code node unless it is started with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, so set that first. Paste the secret where it says, or read it from an n8n variable.

   ```js
   const crypto = require('crypto');
   const secret = 'whsec_...'; // the endpoint's secret from Attendra
   const h = $input.first().json.headers;
   const body = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
   const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
   const expected = Buffer.from('v1,' + crypto.createHmac('sha256', key).update(`${h['webhook-id']}.${h['webhook-timestamp']}.${body}`).digest('base64'));
   const fresh = Math.abs(Date.now() / 1000 - Number(h['webhook-timestamp'])) <= 300;
   const signed = String(h['webhook-signature']).split(' ').some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), expected));
   if (!fresh || !signed) throw new Error('not from Attendra');
   return [{ json: JSON.parse(body) }];
   ```
4. Branch on `{{$json.type}}`: for `appointment.booked`, add a row to the practice's sheet with the time and provider; for `request.created`, post "A new refill request came in" to the team's chat, with a link to Requests. Use the ids to look things up in Attendra; the webhook itself carries no names.
5. Back in Attendra, **Send test event**, and check the execution in n8n.
