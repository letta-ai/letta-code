---
name: using-mcp-tools
description: Reference for finding and invoking MCP tools, plus discovering and managing durable Letta Cloud events for attached managed MCP connections. Use for `letta mcp` browsing/search/calls, large or file-based arguments, MCP troubleshooting, or provider trigger subscriptions delivered to agent webhooks.
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

## Durable events from managed connections

For a named, Letta-managed MCP connection, Letta Cloud can keep a provider
trigger subscription active after the current turn, process, or agent computer
stops. Provider events are delivered only to an existing public Cloud webhook
owned by the same agent. The provider credential stays server-side; never ask
the user for it or try to expose it to the sandbox.

This is **not the MCP Events protocol**. MCP Events is still a draft MCP
proposal for protocol-level event delivery between MCP clients and servers.
The commands below manage Letta Cloud's provider-backed trigger subscriptions
outside the MCP transport. Do not describe a successful subscription as MCP
Events support or assume a draft MCP Events client/server contract.

Use the bundled helper. It is restricted to `AGENT_ID` and does not accept an
agent override:

```bash
node <SKILL_DIR>/scripts/manage-managed-events.mjs <command> [options]
```

The active runtime supplies `LETTA_API_KEY`, `LETTA_BASE_URL`, and `AGENT_ID`.
Do not print those values. The helper rejects redirects, caps JSON files and
responses at 1 MiB, and requires `--confirm` for subscribe/cancel mutations.

### Event workflow

1. Discover attached MCP connection identifiers. Do not guess IDs:

   ```bash
   node <SKILL_DIR>/scripts/manage-managed-events.mjs connections
   ```

   Each result provides `service_id` and `mcp_server_id`. A custom or
   provider-incompatible MCP server can still appear here; `types` is the
   authoritative capability check.

2. Discover provider trigger types and inspect their `config` schema:

   ```bash
   node <SKILL_DIR>/scripts/manage-managed-events.mjs types \
     --service-id <service_id> --server-id <mcp_server_id> --limit 50
   ```

   Follow `next_cursor` until null when more pages are present.

3. List existing subscriptions before creating one, to avoid accidental
   duplicates:

   ```bash
   node <SKILL_DIR>/scripts/manage-managed-events.mjs list \
     --service-id <service_id> --server-id <mcp_server_id> --limit 50
   ```

4. Choose an existing **public** Cloud webhook owned by this agent. Load the
   `managing-agent-webhooks` skill to list or create webhooks. Secured webhooks
   are intentionally ineligible because the provider cannot receive the
   webhook's private authorization header. Creating a public capability URL
   requires the user's explicit acceptance; never substitute a caller-supplied
   URL.

5. Write the provider configuration as a JSON object in a protected file, then
   subscribe only after the user approves that exact trigger and webhook:

   ```bash
   node <SKILL_DIR>/scripts/manage-managed-events.mjs subscribe \
     --service-id <service_id> --server-id <mcp_server_id> \
     --trigger-slug <trigger_slug> --webhook-id <webhook_id> \
     --config-file /tmp/managed-trigger-config.json --confirm
   ```

   Omit `--config-file` only when the trigger accepts an empty configuration.
   Never put sensitive configuration directly in command-line arguments.

6. Cancel one exact subscription only after confirmation:

   ```bash
   node <SKILL_DIR>/scripts/manage-managed-events.mjs cancel \
     --service-id <service_id> --server-id <mcp_server_id> \
     --trigger-id <trigger_id> --confirm
   ```

Subscribe/cancel can complete at the provider even when a connection failure or
non-definitive HTTP response hides the receipt. If the helper returns
`accepted_unconfirmed`, follow its reconciliation guidance and list before any
retry. Never blindly retry a mutation: a duplicate trigger can produce
duplicate agent work.

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
