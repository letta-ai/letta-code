---
name: launch-subagent
description: Contract for the app-server launch_subagent command and the shared Agent subagent launcher it calls. Use when adding or modifying launch_subagent, its AppServerClient.launchSubagent() helper, or subagent launch behavior that must preserve parent/child runtime correlation.
---

# Launch Subagent (`launch_subagent`)

`launch_subagent` is the App Server command that exposes the shared `Agent`
subagent launcher so external tools can start background workers with the same
task tracking, cancellation, and completion notifications as the `Agent` tool.
Change subagent launch behavior in the shared launcher, not in a
command-specific path.

## Key Files

- `src/tools/impl/task.ts` - shared `launchSubagent()` and validation
- `src/types/subagent-protocol.ts` - command, args, and response types
- `src/websocket/listener/commands/subagents.ts` - sideband handler
- `src/websocket/listener/commands/task-control.ts` - detached-task routing
- `src/app-server-client.ts` - `AppServerClient.launchSubagent()`
- `src/types/app-server-info.ts` - `capabilities.launch_subagent`

## Contract Invariants

- **Parent/child scope:** `runtime` is the parent scope (launch context, acting
  user, completion-notification routing); the child is
  `args.agent_id` / `args.conversation_id`. The command runs while the parent
  waits for an external-tool result, and the `runtime` must match the actual
  parent runtime.
- **`subagent_type: "custom"` means "prepared child":** run an already-prepared
  child conversation with no preset applied. The child must exist and must not
  be the parent conversation; `args.model` must be omitted (the caller
  configures prompt, model, and tools before launch). `args.conversation_id`
  must not be `"default"`; when `args.agent_id` is set, it must own the child
  conversation.
- **Sideband:** the launch is a detached listener task that never acquires or
  changes the parent's turn lease and never starts or completes a parent turn.
- **`client_message_id`:** identifies the child's initial assignment input
  (what Cloud correlates), distinct from the command's `request_id`; must be a
  non-empty string when present.
- **Response is launch acknowledgment** (`task_id`, `agent_id`,
  `conversation_id`), not worker completion. Support is advertised via
  `app_server_info.capabilities.launch_subagent`.
