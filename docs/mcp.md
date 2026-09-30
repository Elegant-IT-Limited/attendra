# MCP: other AI agents at the front desk

Attendra runs a [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI agent the clinic uses, such as Claude Desktop, can work with the front desk: find open times, read today's schedule and the request queue, close requests, and see how the assistant is doing. **It cannot book or cancel.** Changes to the schedule stay with people and the phone assistant.

## Keys

An owner or practice manager makes a key under **Settings > API keys**. A key belongs to one clinic, has an expiry (7 days to a year) and one or more scopes:

| Scope | What it allows |
|---|---|
| `schedule:read` | Open times, and today's appointments with patient names |
| `requests:read` | The open refill and callback requests, with the patient and the details |
| `requests:write` | Closing a request, with its outcome |

The key is shown once, when it is made. Attendra keeps only its SHA-256 hash, so a copy of the database holds nothing that works. Revoke a key and it stops at once. Every use is written to the audit log as `mcp.<tool>` with the key's id, including uses a scope refused, and the key shows when it was last used.

A key acts in the name of the person who made it: a request it closes is closed by them, and requests it reads are audited as their views. So a key works only while that person is still an owner or practice manager at the clinic: remove them from the team, or change their role to anything else, and every key they made is revoked, with an `api_key.revoked` row in the audit log. Give each agent its own key, with only the scopes it needs. What a key reads is PHI, and it goes to the MCP client and to the model behind it: whoever runs them needs a BAA before a key is used with real patients ([hipaa.md](hipaa.md)).

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `find_open_slots` | `schedule:read` | Open times for a visit type over the next days, optionally for one provider. No patient data. |
| `list_todays_schedule` | any | Today's appointments. Patient names only with `schedule:read`; the audit row records how many were shown. |
| `list_open_requests` | `requests:read` | Open requests, oldest first, with the patient, the details and the suggested follow-up. |
| `mark_request_done` | `requests:write` | Close a request with `called_back`, `left_message`, `refill_sent` or `not_needed`. It tells the clinic's webhooks, as the dashboard does. |
| `get_quality_summary` | any | The last 7 days of the Quality page's numbers. Counts only. |

## Connecting a desktop MCP client over stdio

A desktop MCP client, such as Claude Desktop, starts a local server over stdio. Attendra's stdio server is a thin bridge to your HTTP `/mcp` server (below): it needs only that address and a key, and never the database or the data key, so the computer it runs on holds nothing that can read patient data. Every message goes through unchanged, and the HTTP server checks the key on every call, so a key revoked while the client is open fails on the next call. Add this to the client's config (for Claude Desktop, `claude_desktop_config.json`, under Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "attendra": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/attendra", "--filter", "@attendra/mcp", "stdio"],
      "env": {
        "ATTENDRA_MCP_URL": "https://mcp.your-clinic.example/mcp",
        "ATTENDRA_API_KEY": "atk_..."
      }
    }
  }
}
```

`ATTENDRA_MCP_URL` must be `https://`, except `http://localhost` for trying it on one machine. A client that can connect to a URL itself does not need the bridge: give it the address and the key directly, as below.

## Connecting over HTTP

`pnpm --filter @attendra/mcp start` serves MCP over Streamable HTTP at `POST /mcp` on `MCP_PORT` (8082 by default); with Compose, `docker compose -f infra/docker-compose.yml --profile mcp up`. Put it behind HTTPS on your own address. Each request carries the key as a bearer token, and the server is stateless: nothing about one request outlives it.

Any MCP client that speaks Streamable HTTP can connect. For example, in a client that takes a JSON config:

```json
{
  "mcpServers": {
    "attendra": {
      "url": "https://mcp.your-clinic.example/mcp",
      "headers": { "Authorization": "Bearer atk_..." }
    }
  }
}
```

Try it from a terminal:

```bash
curl -s https://mcp.your-clinic.example/mcp \
  -H 'Authorization: Bearer atk_...' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A request with no key, or with a revoked or expired one, gets `401`.
