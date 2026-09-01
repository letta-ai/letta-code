---
name: using-mcp-tools
description: Reference for the `letta mcp` CLI, which finds and invokes MCP tools available to this agent. A system reminder already lists your connected MCP servers and the basic search/call commands; invoke this skill when you need more — checking a tool's schema before calling it, passing large or file-based arguments, tuning search, inspecting server configuration and auth, or troubleshooting missing servers, tools, and errors.
---

# Using MCP tools

`letta mcp` gives the agent one unified view of every MCP server it can reach: servers connected to the agent in Letta Cloud and servers configured locally on this machine. It works from any surface where the agent runs — cloud sandboxes (chat.letta.com), Letta Desktop, and terminals. All output is JSON.

## Commands

```bash
letta mcp list                                # servers: [{name, transport}]
letta mcp get <server>                        # one server's connection configuration
letta mcp tools [server] [--full]             # tool names + descriptions; --full adds complete schemas
letta mcp schema <tool-name>                  # one tool's complete schema
letta mcp search <query> [--mode] [--limit]   # ranked tool schemas: [{tool, rank, score}]
letta mcp call <tool-name> [--args | --args-file]  # run a tool, print a CallToolResult
```

Every command accepts `--agent <id>`, defaulting to `LETTA_AGENT_ID`/`AGENT_ID` — do not pass it unless targeting another agent.

## Workflow

1. **Search** by describing what you want to do: `letta mcp search "create a calendar event"`. Each result's `tool.name` (shaped like `mcp__<server>__<tool>`) is the exact callable name, and `tool` includes its full schema.
2. **Check the schema first** for any tool whose arguments you have not seen — a name from a `tools` listing, a reminder, or memory: `letta mcp schema <tool-name>`. Do not guess arguments; required fields fail with avoidable round trips.
3. **Call** with the exact name and a JSON object: `letta mcp call <tool-name> --args '{"key":"value"}'`.

Never invent tool names — `call` and `schema` require a name printed by `search` or `tools`.

## Search options

- `--mode <hybrid|vector|fts>` — default `hybrid`. `vector` uses server-side embeddings and covers only cloud-connected servers; `fts` and `hybrid` also rank local tools lexically. Agents on a local backend cannot use `vector`.
- `--limit <n>` — result count, 1-100 (default 5).
- Rank order is meaningful; absolute scores are not comparable across queries. When even the top results look unrelated to the query, no relevant tool likely exists — do not force the best-ranked one.

## Call arguments and results

- `--args '<json>'` — inline JSON object.
- `--args-file <path>` — read the JSON object from a file; `--args-file -` reads stdin. Use these for large or shell-quoting-hostile payloads.
- Output is an MCP CallToolResult: `content` (array of typed blocks), optional `structuredContent`, and `isError`.
- Exit codes: `0` success, `1` CLI/usage error (JSON on stderr: `{error: {code, message, hint?}}`), `2` the tool ran and returned an error result — read `content` for the server's message, fix the arguments, and retry.
- Summarize relevant results instead of pasting large raw payloads.

## Servers

Two kinds of servers share one namespace:

- **Cloud-connected servers** are attached to the agent on the Letta server (MCP servers page in ADE/chat, or the agent MCP API). They follow the agent to every environment and their tools execute server-side. `stdio`-type cloud servers cannot run on hosted Letta Cloud.
- **Local client servers** are per-agent, per-machine settings the user configures in the Letta Code app. Their tools execute on this machine. Header values may reference environment variables as `${VAR_NAME}`, resolved at connect time; a missing variable is a hard error.

`get` output is safe to show: header values are `[REDACTED]` and sensitive URL query parameters (token/key/secret/password) are masked.

OAuth: a local http/sse server with no `Authorization` header uses the OAuth flow. The interactive browser handshake only happens in the Letta Code app; this CLI is non-interactive and reuses persisted credentials. On an auth error, ask the user to connect the server once in the app.

## Troubleshooting

- `list` empty → no MCP servers are available. Ask the user to connect one on the Letta Cloud MCP servers page or configure a local one in the Letta Code app.
- Cloud server with no tools (or `0 tools` in the reminder) → tools were never synced. Ask the user to resync it from the MCP servers page; the CLI has no refresh action.
- `unauthorized` from a cloud server on `call` while `tools` still lists them → the stored connection lost or lacks credentials; the tool list is served from previously synced rows. Ask the user to re-authenticate the server on the MCP servers page.
- `ambiguous_server_name` → two servers share a name; the error hint explains how to disambiguate.
- Duplicate tool names across servers get a numeric suffix (`_2`); the printed name is always the callable one.
