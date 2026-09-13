---
name: using-mcp-tools
description: Reference for the `letta mcp` CLI, which finds and invokes MCP tools available to this agent. A system reminder already lists your connected MCP servers and the basic search/schema/call commands; invoke this skill when you need more — browsing a server's tools, passing large or file-based arguments, tuning search, or troubleshooting missing servers, tools, and errors.
---

# Using MCP tools

`letta mcp` gives the agent one unified view of every MCP server it can reach: servers connected to the agent in Letta Cloud and servers configured locally on this machine. It works from any surface where the agent runs — cloud sandboxes (chat.letta.com), Letta Desktop, and terminals. All output is JSON.

## Commands

```bash
letta mcp list                                # servers: [{name, transport}]
letta mcp get <server>                        # one server's connection configuration (credentials redacted)
letta mcp tools [server]                      # tool names + descriptions only
letta mcp tools [server] --full               # ...including every tool's complete schema
letta mcp schema <tool-name>                  # one tool's complete schema
letta mcp search <query> [--mode] [--limit]   # ranked tool schemas: [{tool, rank, score}]
letta mcp call <tool-name> [--args | --args-file]  # run a tool, print a CallToolResult
```

Every command accepts `--agent <id>`, defaulting to `LETTA_AGENT_ID`/`AGENT_ID` — do not pass it unless targeting another agent.

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

## Troubleshooting

- `list` empty → no MCP servers are available. Ask the user to connect one on the Letta Cloud MCP servers page or configure a local one in the Letta Code app.
- Cloud server with no tools (or `0 tools` in the reminder) → tools were never synced. Ask the user to resync it from the MCP servers page; the CLI has no refresh action.
- `unauthorized` or another auth error on `call` → the server's stored credentials are missing or stale (`tools` can still list from previously synced rows). Ask the user to re-authenticate the server: cloud servers on the MCP servers page, local OAuth servers by connecting once in the Letta Code app — this CLI is non-interactive and only reuses persisted credentials.
- `ambiguous_server_name` → two servers share a name; the error hint explains how to disambiguate.
- Duplicate tool names across servers get a numeric suffix (`_2`); the printed name is always the callable one.
