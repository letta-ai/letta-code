# letta-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) adapter for
Letta. It exposes a stateful Letta agent as an ACP agent over stdio, so any ACP
client — Zed, JetBrains, marimo, or the bundled test client — can drive it.

Built on [`@letta-ai/letta-agent-sdk`](https://github.com/letta-ai/letta-agent-sdk)
(agent/session management, streaming, tool approvals) and
[`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
(protocol plumbing).

## ACP v1, not v2

This adapter implements **protocol v1** (`protocolVersion: 1`):

- v1 is the current stable wire protocol. Every shipping ACP client (including
  Zed) negotiates v1 during `initialize`.
- v2 exists only as an unstable schema surface (`@agentclientprotocol/sdk`
  ships it under `experimental/v2`) that is still churning — MCP-aligned
  content types, `auth/*` regrouping, unified session lifecycle — with no
  stable release or client support yet.

When v2 stabilizes, the migration is mostly mechanical (the SDK exposes a
`dual-version-agent` example for serving both).

## Quick start

```bash
cd acp
bun install

# smoke test with the bundled ACP client (spawns the agent over stdio)
bun test-client.ts
bun test-client.ts "List the files in this directory using your tools."
```

The first session creates a Letta agent and logs its id to stderr; set
`LETTA_AGENT_ID` to that value to keep using the same agent (that's the point —
its memory persists across sessions and editors).

## Use from Zed

Add to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Letta": {
      "command": "bun",
      "args": ["/path/to/letta-code/acp/src/index.ts"],
      "env": { "LETTA_AGENT_ID": "agent-..." }
    }
  }
}
```

Then open the Agent Panel, choose **Letta**, and start a thread.

## Configuration

| Variable | Effect |
|----------|--------|
| `LETTA_ACP_BACKEND` | `local` (default, SDK-managed app-server), `remote`, or `cloud` |
| `LETTA_APP_SERVER_URL` | remote backend URL (default `ws://127.0.0.1:4500`) |
| `LETTA_APP_SERVER_TOKEN` | remote backend auth token |
| `LETTA_API_KEY` | cloud backend API key |
| `LETTA_AGENT_ID` | reuse an existing agent instead of creating one |
| `LETTA_ACP_MODEL` | model override for sessions |
| `LETTA_ACP_PERMISSION_MODE` | `standard` (default), `acceptEdits`, `unrestricted` |

## What's implemented

| ACP surface | Status |
|-------------|--------|
| `initialize` (v1 negotiation) | ✅ |
| `session/new` (per-session Letta conversation, cwd) | ✅ |
| `session/prompt` (text, image, resource, resource_link) | ✅ |
| `session/update` — message/thought chunks, tool calls, tool results | ✅ |
| `session/request_permission` (allow once / always / reject) | ✅ |
| `session/cancel` → `stopReason: cancelled` | ✅ |
| `session/load` | ❌ (capability off) |
| Client fs / terminal delegation | ❌ (tools run Letta-side) |

## How it works

`src/agent.ts` maps the two protocols:

- Each ACP session becomes a new conversation (`client.createSession`) on one
  underlying Letta agent, with the ACP `cwd`.
- `session/prompt` sends the message and pumps `session.stream()`, translating
  SDK messages (`assistant`, `reasoning`, `tool_call`, `tool_result`) into
  `session/update` notifications.
- Tool approvals: the SDK's `canUseTool` callback is forwarded as an ACP
  `session/request_permission` request. One Letta-specific wrinkle: the
  app-server transport ends the turn with a recoverable `approval_conflict`
  result while the approval is pending, and the resumed run streams without a
  second terminal result — so after such a result the adapter keeps pumping
  the stream (approvals resolve concurrently over the control channel) and
  ends the turn when the agent loop reports it is idle again.
