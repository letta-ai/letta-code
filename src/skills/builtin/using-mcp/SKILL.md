---
name: using-mcp
description: Uses MCP tools available to this agent (local `/mcp` servers and servers connected in Letta Cloud) through the `letta mcp` CLI. To use a tool, this skill is not required — run `letta mcp search "<what you want to do>"` to get ranked tool schemas, then `letta mcp call <tool-name> --args '{"key":"value"}'` with the exact `name` from the results. Load this skill to list or inspect MCP servers, tune search modes and limits, pass large arguments, or troubleshoot missing servers, tools, or errors.
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
letta mcp get <server>     # one server's redacted connection configuration
letta mcp tools [server]   # complete tool schemas; names are accepted by call
```

## Options

- `--agent <id>` — defaults to `LETTA_AGENT_ID`/`AGENT_ID`; do not pass it unless targeting another agent.
- `--mode <hybrid|vector|fts>` — search mode, default `hybrid`. Agents on the local backend cannot use `vector`.
- `--limit <n>` — search result count, 1–100 (default 5).

## Rules

- Never invent tool names. `call` requires the exact `name` printed by `search` or `tools`.
- Summarize relevant results instead of pasting large raw payloads.
- If `list` is empty, no MCP servers are available: connect one to the agent on the Letta Cloud MCP servers page, or add a local one with `/mcp`.
- If a Cloud-connected server shows no tools, its tools were never synced. Ask the user to resync it from the MCP servers page; the CLI has no refresh action.
- `stdio`-transport servers connected in Letta Cloud cannot run on hosted Letta Cloud. Tell the user instead of retrying. Local `/mcp` stdio servers run fine.
- Local `/mcp` server configuration is per-agent, per-machine settings; Cloud-connected servers follow the agent everywhere. Both appear in the same `list`/`search`/`call` namespace.
