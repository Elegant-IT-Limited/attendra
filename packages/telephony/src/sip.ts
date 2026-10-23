// SPDX-License-Identifier: AGPL-3.0-only

type Header = { name: string; value: string };

const NUMBER_IN_URI = /(?:sips?:|tel:)\+?(\d{8,15})(?![\d])/g;
const BARE_NUMBER = /\+(\d{8,15})(?![\d])/g;
// who is calling, never which clinic was called
const CALLER_HEADERS = new Set(['from', 'contact', 'p-asserted-identity', 'p-preferred-identity', 'remote-party-id', 'referred-by']);

const e164 = (digits: string) => (digits.length === 10 ? `+1${digits}` : `+${digits}`);

/**
 * The dialled number on an inbound SIP call. Twilio's Elastic SIP Trunk puts it in
 * the To header, as a sip: or tel: URI. SIP headers are caller-controlled metadata,
 * so this is used only to pick which clinic's configuration to load, never to
 * authorise anything.
 */
export function dialledNumber(headers: Header[]): string | null {
  const to = headers.find((h) => h.name.toLowerCase() === 'to')?.value ?? '';
  const m = to.match(/(?:sips?:|tel:)\+?(\d{8,15})/);
  return m ? `+${m[1]}` : null;
}

/**
 * Every number that may be the one dialled, best first: the To header, then any
 * other header except the ones naming the caller. When a trunk sends the call to a
 * SIP address (Twilio to OpenAI's project address), the To header can hold that
 * address and the number arrives elsewhere. Each candidate is only looked up among
 * the clinics' own numbers.
 */
export function dialledCandidates(headers: Header[]): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    for (const re of [NUMBER_IN_URI, BARE_NUMBER]) for (const m of value.matchAll(re)) found.push(e164(m[1]!));
  };
  for (const h of headers) if (h.name.toLowerCase() === 'to') add(h.value);
  for (const h of headers) if (h.name.toLowerCase() !== 'to' && !CALLER_HEADERS.has(h.name.toLowerCase())) add(h.value);
  return [...new Set(found)];
}

/** The headers for a log line, with every run of 7 or more digits cut to its first 4 and last 4. */
export function maskedHeaders(headers: Header[]): string[] {
  return headers.map((h) => `${h.name}: ${h.value.replace(/\d{7,}/g, (d) => `${d.slice(0, 4)}***${d.slice(-4)}`)}`.slice(0, 200));
}

export function callerNumber(headers: Header[]): string | null {
  const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
  const m = from.match(/(?:sips?:|tel:)\+?(\d{8,15})/);
  return m ? `+${m[1]}` : null;
}
