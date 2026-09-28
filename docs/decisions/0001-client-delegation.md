# 1. GPT-Live with client delegation

**Status:** accepted, 2026-09-28

GPT-Live can run backend work itself (Responses delegation) or hand it to our application (client delegation). We use client delegation.

The things this product must guarantee (identity before records, a read-back and a yes before writes, idempotent writes, discarding stale results, an audit trail) are all about who runs the tool loop. With Responses delegation that loop runs in OpenAI's infrastructure and our guarantees become requests in a prompt. With client delegation every tool call passes through `runTool`, which we test.

The cost is that we keep the conversation state ourselves: `session.delegation.created` carries no task text, so `CallState` rebuilds the request from transcript deltas. We accept that; it is also what makes the simulator possible.

Revisit if GPT-Live gains server-side hooks that let us enforce these checks without running the loop.
