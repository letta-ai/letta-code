---
name: using-cloud-mcp
description: Uses MCP servers available to the current Letta Cloud agent. Load when the user asks to use a connected MCP server, list the agent's MCP servers or MCP tools, run an MCP tool connected in ADE/chat, or mentions cloud MCP, server-side MCP, agent MCP, `letta mcp`, or `letta cloud-mcp`.
---

# Using Cloud MCP

Letta Cloud stores MCP server connections per agent. The `letta mcp` CLI lists, searches, and calls MCP tools available to the current agent, so it works from any surface where the agent runs: cloud sandboxes (chat.letta.com), Letta Desktop, and terminals.

`letta cloud-mcp` is the legacy JSON-only command family. Prefer `letta mcp` unless the user explicitly asks about the legacy command.

## Workflow

1. List MCP servers connected to this agent:

```bash
letta mcp list
```

2. List tools. Omit the server name to list every available tool, or pass a server name from the list output to narrow results:

```bash
letta mcp tools
letta mcp tools <server-name>
```

3. Search tools when the user asks for a capability but you do not know the exact tool name:

```bash
letta mcp search "<query>"
```

4. Call a tool by its exact tool name with a JSON object:

```bash
letta mcp call <tool-name> --args '{"key":"value"}'
```

## Rules

- Do not ask for an agent ID unless the user wants another agent. The CLI reads `LETTA_AGENT_ID`/`AGENT_ID` from the environment.
- Treat command output as JSON. Summarize relevant results instead of pasting large raw payloads.
- If `list` is empty, ask the user to connect an MCP server to the agent on the MCP servers page.
- If `tools` is empty for a connected server, the server's tools may not be enabled or synced. Ask the user to enable/resync the server from the MCP servers page; the CLI has no refresh action.
- `letta mcp list` can include both server-side servers registered on Letta Cloud and client-local servers configured for this agent. Server-side tools execute on the Letta server; client-local tools execute on the machine running Letta Code.
- This requires a signed-in Letta Cloud agent for server-side MCP servers. MCP servers configured only in another local terminal/session may not be available from this runtime.

## Legacy command reference

Use these only when diagnosing old behavior or when the user explicitly asks about `letta cloud-mcp`:

```bash
letta cloud-mcp list
letta cloud-mcp tools <mcp-server-id>
letta cloud-mcp run <mcp-server-id> <tool-id> --args '{"key":"value"}'
```
