---
name: using-cloud-mcp
description: Uses MCP servers connected to the current Letta Cloud agent (cloud MCP). Load when the user asks to use a connected MCP server, list the agent's MCP servers or MCP tools, run an MCP tool connected in ADE/chat, or mentions cloud MCP, server-side MCP, agent MCP, or `letta cloud-mcp`.
---

# Using Cloud MCP

Letta Cloud stores MCP server connections per agent. The `letta cloud-mcp` CLI lists and runs those servers' tools through the Letta API, so it works from any surface where the agent runs: cloud sandboxes (chat.letta.com), Letta Desktop, and terminals.

## Workflow

1. List MCP servers connected to this agent:

```bash
letta cloud-mcp list
```

2. Pick the relevant `id` from the JSON output, then list its tools:

```bash
letta cloud-mcp tools <mcp-server-id>
```

3. Pick a tool `id`, inspect its name and description, and run it with a JSON object:

```bash
letta cloud-mcp run <mcp-server-id> <tool-id> --args '{"key":"value"}'
```

## Rules

- For a Letta Cloud agent, prefer cloud MCP over harness-scoped MCP (the TUI `/mcp` command). Cloud MCP works everywhere; harness MCP only exists in terminal TUI and headless runs. Harness MCP remains the right tool for stdio servers and servers on localhost or private networks, which Letta Cloud cannot reach.
- Cloud MCP runs streamable HTTP and SSE servers with public URLs. stdio servers do not run on hosted Letta Cloud.
- Do not ask for an agent ID unless the user wants another agent. The CLI reads `LETTA_AGENT_ID`/`AGENT_ID` from the environment.
- Treat command output as JSON. Summarize relevant results instead of pasting large raw payloads.
- If `list` is empty, ask the user to connect an MCP server to the agent on the MCP servers page.
- If `tools` is empty for a connected server, the server's tools were never synced. Ask the user to resync the server from the MCP servers page; the CLI has no refresh action.
- This only works for signed-in Letta Cloud agents. It is separate from local MCP transport testing and from converting arbitrary MCP servers into skills.
