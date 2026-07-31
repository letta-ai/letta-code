# Letta Agent SDK design patterns

Use this reference to choose the system shape before implementation. Fetch the
official docs again when exact options or behavior matter.

## Contents

- Backend selection
- Identity and conversation topology
- State ownership
- Capability surfaces
- Automation candidates
- Vertical-slice checklist
- Current official sources

## Backend selection

| Need | Backend | Agent state | Tool execution |
|---|---|---|---|
| Fully managed | `cloud`, no environment | Letta Cloud | Managed sandbox |
| Cloud identity on a chosen machine | `cloud` with `environment` | Letta Cloud | Selected remote environment |
| Fully local | `local` | Current machine | Current machine |
| Runtime operated separately | `remote` | App Server backend | App Server machine |

For Cloud sessions, a caller's `process.cwd()` is not mounted into a managed
sandbox. Set `cwd` to a path that exists in the selected execution environment.
For client tools and MCP, remember that the implementation runs in the Node.js
SDK host even when the agent runs in Cloud or on a remote App Server.

Use a stable environment `id` or `deviceId` for durable routing. A
`connectionId` names one live connection and can change after reconnect.

## Identity and conversation topology

- Use one persistent agent identity per durable role, not per task invocation.
- Use separate conversations for independent work streams that should not share
  immediate turn history.
- Resume the same conversation for a continuing workflow.
- Store agent IDs, conversation IDs, and product role mappings in the
  controller database. Process memory is a cache, never the owner.
- Parallelize across different conversations or agents. Keep at most one active
  turn per `{agentId, conversationId}` from one controller.

`createSession(agentId)` starts a new conversation. `resumeSession(agentId)`
resumes the agent's default conversation. `resumeSession(conversationId)`
resumes that exact thread. `prompt()` creates a short-lived new conversation;
it is a poor fit when thread continuity is the point.

## State ownership

The application owns:

- users, projects, teams, tasks, jobs, and status
- authorization and secrets
- idempotency keys and retry decisions
- durable results and effect receipts
- runtime registry and conversation mappings
- raw or reduced event logs needed for recovery

The Letta runtime owns:

- agent identity, memory, and conversation history
- turn execution and built-in computer-use tools
- runtime CWD and permission mode
- streaming model/tool events

Do not turn agent memory into a hidden product database. Give the agent the
context it needs and keep authoritative business state in ordinary storage.

## Capability surfaces

Use built-in tools for generic computer use such as reading files, editing, and
shell commands.

Use client tools for narrow JavaScript functions owned by the SDK host. Use
strict JSON schemas, bounded outputs, abort signals, and stable receipt IDs.

Use MCP when an existing server already owns the integration. MCP connections,
stdio children, credentials, and filesystem access live on the SDK host and are
session-scoped.

Use Cloud repositories for hosted, git-backed UTF-8 text that should be
projected into a Cloud session. Repository resources are read-write by default,
session cleanup is asynchronous, and concurrent sessions are not
reference-counted. Use content-hash preconditions for concurrent writes.

Use direct App Server protocol control only when the Agent SDK does not expose
the needed lifecycle or event primitive. Product-specific actions normally
belong in client/external tools rather than new protocol commands.

Treat tool visibility as a model-facing surface, not an authorization boundary.
The controller must enforce real authorization.

## Automation candidates

Good SDK candidates have one or more of these properties:

- a resident project maintainer should accumulate conventions and history
- recurring research or operations should improve from past runs
- a workflow needs human-facing conversation plus background execution
- several durable roles should coordinate while retaining separate identities
- app data should be available through narrow, audited actions
- work must resume across process or machine restarts

Weak candidates:

- deterministic transforms with no need for memory or judgment
- one API call hidden behind an agent
- high-volume stateless inference
- tasks whose authoritative state would exist only in a prompt

## Vertical-slice checklist

Build one path through:

1. Resolve or create the intended persistent agent.
2. Resolve or create the intended conversation.
3. Select execution environment and CWD explicitly.
4. Register the smallest necessary tools and permission policy.
5. Send one idempotently identified request.
6. Consume and persist events through terminal result.
7. Commit one bounded product artifact or state transition.
8. Verify the effect outside the agent transcript.
9. Close the session and verify cleanup behavior.
10. Write the SDK feedback record.

## Current official sources

- Quickstart: https://docs.letta.com/agent-sdk/quickstart
- API reference: https://docs.letta.com/agent-sdk/reference
- Deployment: https://docs.letta.com/agent-sdk/deployment
- MCP and client tools: https://docs.letta.com/agent-sdk/mcp
- Cloud repositories: https://docs.letta.com/agent-sdk/repositories
- App Server integration patterns:
  https://docs.letta.com/platform/app-server/integration-patterns
- External tools:
  https://docs.letta.com/platform/app-server/external-tools
- Package: https://www.npmjs.com/package/@letta-ai/letta-agent-sdk
- Source: https://github.com/letta-ai/letta-agent-sdk
