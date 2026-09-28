// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The dialled number on an inbound SIP call. Twilio's Elastic SIP Trunk puts it in
 * the To header, as a sip: or tel: URI. SIP headers are caller-controlled metadata,
 * so this is used only to pick which clinic's configuration to load, never to
 * authorise anything.
 */
export function dialledNumber(headers: { name: string; value: string }[]): string | null {
  const to = headers.find((h) => h.name.toLowerCase() === 'to')?.value ?? '';
  const m = to.match(/(?:sips?:|tel:)\+?(\d{8,15})/);
  return m ? `+${m[1]}` : null;
}

export function callerNumber(headers: { name: string; value: string }[]): string | null {
  const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
  const m = from.match(/(?:sips?:|tel:)\+?(\d{8,15})/);
  return m ? `+${m[1]}` : null;
}
