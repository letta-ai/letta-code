---
name: using-mcp
description: Uses MCP tools available to this agent (local `/mcp` servers and servers connected in Letta Cloud) through the `letta mcp` CLI. To use a tool, this skill is not required — run `letta mcp search "<what you want to do>"` to get ranked tool schemas, then `letta mcp call <tool-name> --args '{"key":"value"}'` with the exact `name` from the results. Load this skill to list, inspect, add, or configure MCP servers (transports, auth, OAuth), tune search modes and limits, pass large arguments, or troubleshoot missing servers, tools, or errors.
---

# Using MCP

`letta mcp` gives the agent one unified view of every MCP server it can reach: servers configured locally with `/mcp` and servers connected to the agent in Letta Cloud. It works from any surface where the agent runs: cloud sandboxes (chat.letta.com), Letta Desktop, and terminals. All output is JSON.

## Protocol: search, then call

1. Search for a tool by describing what you want to do:

```bash
letta mcp search "<query>"
```

Prints ranked results `[{tool, rank, score}]`. Each `tool` is a JSON schema whose `name` (shaped like `mcp__<server>__<tool>`) is the exact callable name. If a result has `tool: null`, fetch its schema with `letta mcp tools`.

2. Call the tool with the exact returned `name` and a JSON object of arguments:

```bash
letta mcp call <tool-name> --args '{"key":"value"}'
```

Prints an MCP CallToolResult (`content`, optional `structuredContent`, `isError`). Exit code 2 means the tool ran and returned an error result. For large arguments, use `--args-file <path>` or `--args-file -` to read from stdin.

## Inspecting servers

```bash
letta mcp list             # servers available to the agent: [{name, transport}]
letta mcp get <server>     # one server's connection configuration
letta mcp tools [server]   # complete tool schemas; names are accepted by call
```

`get` redacts credentials: header values are replaced with `[REDACTED]` and sensitive URL query parameters (token/key/secret/password) are masked, so its output is safe to show.

## Where servers come from

Two kinds of servers appear in the same `list`/`search`/`call` namespace:

- **Cloud-connected servers** are attached to the agent on the Letta server (MCP servers page in ADE/chat, or the agent MCP API). They follow the agent to every environment, their tools execute server-side, and they power `vector`/`hybrid` search. `stdio`-type cloud servers cannot run on hosted Letta Cloud.
- **Local client servers** are per-agent, per-machine settings managed with `/mcp`. Their tools execute on this machine (stdio processes run locally).

## Configuring local servers with /mcp

`/mcp` opens the manager (lists both kinds; enables/disables server-side tools for this agent). `/mcp add` adds a local server:

```
/mcp add --transport stdio filesystem npx -y @modelcontextprotocol/server-filesystem .
/mcp add --transport http notion https://mcp.notion.com/mcp
/mcp add --transport http private https://mcp.example.com/mcp --auth-env MCP_API_TOKEN
```

Options for `/mcp add`:

- `--transport <stdio|http|sse>` — stdio takes a command plus args; http/sse take a URL.
- `--header "Name: value"` — repeatable http/sse header. Header values may reference environment variables as `${VAR_NAME}`; they are resolved at connect time and a missing variable is a hard error.
- `--auth-env TOKEN_ENV_VAR` — stores `Authorization: Bearer ${TOKEN_ENV_VAR}` without persisting the secret itself.
- `--cwd PATH`, `--env KEY=VALUE` — stdio working directory and repeatable environment variables.

OAuth: an http/sse server with no `Authorization` header automatically gets the OAuth flow. The interactive browser handshake only happens in the TUI (`/mcp`); the `letta mcp` CLI is non-interactive and reuses the persisted OAuth credentials. If a call fails with an auth error, connect the server once via `/mcp` first.

## Options

- `--agent <id>` — defaults to `LETTA_AGENT_ID`/`AGENT_ID`; do not pass it unless targeting another agent.
- `--mode <hybrid|vector|fts>` — search mode, default `hybrid`. `vector` requires cloud-connected servers (server-side embeddings) and excludes local servers; `fts`/`hybrid` cover both, ranking local tools lexically.
- `--limit <n>` — search result count, 1-100 (default 5).

## Rules

- Never invent tool names. `call` requires the exact `name` printed by `search` or `tools`.
- Summarize relevant results instead of pasting large raw payloads.
- If `list` is empty, no MCP servers are available: connect one to the agent on the Letta Cloud MCP servers page, or add a local one with `/mcp add`.
- If a cloud-connected server shows no tools, its tools were never synced. Ask the user to resync it from the MCP servers page; the CLI has no refresh action.
- The legacy `letta cloud-mcp` command uses different routes and IDs; do not mix it with `letta mcp`.
