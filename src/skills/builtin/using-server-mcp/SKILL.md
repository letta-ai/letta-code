---
name: using-server-mcp
description: Uses MCP servers that are already connected to the current Letta Cloud agent through server-side MCP associations. Load when the user asks to use an associated MCP server, list an agent's MCP servers or MCP tools, run an MCP tool connected in ADE/chat, or mentions server-side MCP, agent MCP, or `letta server-mcp`.
---

# Using Server-Side MCP

Use this skill when the current Letta Cloud agent has MCP servers connected in Letta and you need to discover or run their tools.

## Workflow

1. List connected MCP servers:

```bash
letta server-mcp list
```

2. Pick the relevant `id` from the JSON output, then list its tools:

```bash
letta server-mcp tools <mcp-server-id>
```

3. Pick a tool `id`, inspect the tool name/description, and run it with a JSON object:

```bash
letta server-mcp run <mcp-server-id> <tool-id> --args '{"key":"value"}'
```

## Rules

- Prefer the `letta server-mcp ...` CLI over model-facing MCP tools. There is no dedicated `agent_mcp` tool.
- Do not ask for an agent ID unless the user wants another agent. In normal Letta Code sessions the CLI reads `LETTA_AGENT_ID`/`AGENT_ID` from the environment.
- Treat command output as JSON. Summarize relevant results instead of pasting large raw payloads.
- If no servers are listed, tell the user to connect an MCP server to the agent in the MCP servers page first.
- This only works for signed-in Letta Cloud agents with server-side MCP support. It is separate from local MCP transport testing or converting arbitrary MCP servers into skills.
