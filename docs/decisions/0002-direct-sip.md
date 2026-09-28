# 2. Direct SIP from Twilio to OpenAI

**Status:** accepted, 2026-09-28

Twilio's Elastic SIP Trunk sends the call straight to `sip.api.openai.com`. The alternative, Twilio Media Streams to our own WebSocket bridge, puts call audio through our servers.

Direct SIP has one hop less of latency, no audio for us to secure or store, and less to run. Our backend still owns every decision through the webhook and the sideband.

It is inbound-only for our purposes and requires GPT-Live SIP on the OpenAI project. The Media Streams bridge stays on the roadmap for outbound calls and for self-hosters who need audio to stay on their own infrastructure; it will implement the same `VoiceEngine` interface.
