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

A key acts in the name of the person who made it: a request it closes is closed by them, and requests it reads are audited as their views. Give each agent its own key, with only the scopes it needs.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `find_open_slots` | `schedule:read` | Open times for a visit type over the next days, optionally for one provider. No patient data. |
| `list_todays_schedule` | any | Today's appointments. Patient names only with `schedule:read`; the audit row records how many were shown. |
| `list_open_requests` | `requests:read` | Open requests, oldest first, with the patient, the details and the suggested follow-up. |
| `mark_request_done` | `requests:write` | Close a request with `called_back`, `left_message`, `refill_sent` or `not_needed`. It tells the clinic's webhooks, as the dashboard does. |
| `get_quality_summary` | any | The last 7 days of the Quality page's numbers. Counts only. |

## Connecting Claude Desktop

Claude Desktop starts a local server over stdio. Add this to its `claude_desktop_config.json` (Settings > Developer > Edit Config), with the path to your Attendra checkout, your database and your key:

```json
{
  "mcpServers": {
    "attendra": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/attendra", "--filter", "@attendra/mcp", "stdio"],
      "env": {
        "DATABASE_URL": "postgres://attendra:...@your-db:5432/attendra",
        "ATTENDRA_DATA_KEY": "the same data key the other services use",
        "ATTENDRA_API_KEY": "atk_..."
      }
    }
  }
}
```

The stdio server needs the database and the data key because it runs as part of your Attendra install. For an agent anywhere else, use HTTP.

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
