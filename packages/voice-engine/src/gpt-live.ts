// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from '@attendra/core';
import OpenAI from 'openai';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import type { Sideband, SidebandEvent, VoiceEngine } from './engine';
import { conversationPrompt } from './prompt';

/**
 * GPT-Live over direct SIP. Twilio sends the call to OpenAI; OpenAI sends us a
 * webhook; we accept with the clinic's configuration and attach a sideband socket.
 * Call audio never passes through our servers on this path.
 */
export class GptLiveEngine implements VoiceEngine {
  readonly name = 'gpt-live';

  constructor(private readonly client: OpenAI, private readonly model = 'gpt-live-1') {}

  async accept(sessionId: string, clinic: ClinicConfig, now: Date) {
    await this.client.live.sessions.accept(sessionId, {
      session: {
        type: 'live',
        model: this.model,
        instructions: conversationPrompt(clinic, now),
        audio: { output: { voice: clinic.voice } },
        // client delegation: our backend runs every tool, so identity checks,
        // confirmations and audit stay in code we own
        delegation: { type: 'client' },
        store: false, // nothing kept on OpenAI's side beyond the call (Zero Data Retention)
      },
    });
  }

  async reject(sessionId: string, sipStatus: number) {
    await this.client.live.sessions.reject(sessionId, { status_code: sipStatus });
  }

  attach(sessionId: string): Sideband {
    const ws = new SidebandWS(this.client, { session_id: sessionId });
    return {
      send: (event) => ws.send(event),
      onEvent: (handler) => ws.on('event', (e) => handler(e as SidebandEvent)),
      onError: (handler) => ws.on('error', (err) => handler(err)),
      onClose: (handler) => ws.socket.on('close', (code: number) => handler(code)),
      close: () => ws.close(),
    };
  }

  async transfer(sessionId: string, targetUri: string) {
    await this.client.live.sessions.refer(sessionId, { target_uri: targetUri });
  }

  async hangup(sessionId: string) {
    await this.client.live.sessions.hangup(sessionId);
  }
}
