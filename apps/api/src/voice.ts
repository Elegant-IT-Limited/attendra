// SPDX-License-Identifier: AGPL-3.0-only
import { TestCall } from './contracts';
import type { VoiceClient } from './http/tokens';

/** The voice service's internal routes, authenticated with the token both services share. */
export function httpVoiceClient(baseUrl: string, token: string, timeoutMs = 15_000): VoiceClient {
  const base = baseUrl.replace(/\/+$/, '');
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const refused = (status: number) => Object.assign(new Error('the voice service refused'), { code: `voice_${status}`, status });

  return {
    async startTestCall(clinicId, userId, sdp) {
      const res = await post('/internal/web-calls', { clinicId, userId, sdp });
      if (res.status !== 201) throw refused(res.status);
      return TestCall.parse(await res.json());
    },
    async endTestCall(clinicId, callId) {
      const res = await post(`/internal/web-calls/${encodeURIComponent(callId)}/end`, { clinicId });
      if (res.status !== 202) throw refused(res.status);
    },
  };
}
