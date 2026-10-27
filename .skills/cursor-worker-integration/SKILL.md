---
name: cursor-worker-integration
description: Work on the Cursor coding worker in Letta Code, where Agent({ subagent_type: "cursor" }) delegates coding work to Cursor's SDK in a child process. Use when changing Cursor worker behavior, session or steering semantics, Cursor model-handle handling, or the Cursor live lifecycle tests.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-5d573fe6-d327-4221-80bd-e2bd857499b8"]'
  rationale: 'The trajectory implemented the Cursor worker behind Agent() (PR #5286) and worked out its Agent() contract mapping, SDK steering semantics, credential requirements, and model-catalog boundary through live testing and review. Future Cursor work — the cloud-agent path, model discovery, and default-model handling are unfinished — would otherwise re-derive these constraints from the PR and Cursor docs.'
---

# Cursor Worker Integration

Cursor is an external coding worker behind `Agent()`, alongside Claude Code,
Codex, and OpenCode. `subagent_type: "cursor"` runs `@cursor/sdk` in a child
worker process against the selected computer's checkout: `cursor_...` session
handles work with `SendAgentMessage`, `TaskStop` cancels the run, `computer`
routes to the machine whose checkout it works in, and the SDK secret env comes
from the parent agent's vault. Sessions persist their checkout, model, and SDK
store under the parent agent's Cursor session directory. The integration does
not launch Cursor-hosted VMs and does not create a Letta agent for the worker.

Key files: `src/tools/impl/cursor-worker.ts`, `src/tools/impl/cursor-session.ts`
(plus `cursor-session.integration.ts` and `cursor-session.node-test.ts`).

## Constraints that change behavior

- **Authentication:** `CURSOR_API_KEY` is required, in the parent agent's
  vault or the execution environment. The SDK does not reuse installed IDE
  credentials. Its browser-login flow (`Cursor.auth.login()`) mints an expiring
  user API key persisted to `~/.cursor/sdk/auth.json`; user keys bill to the
  user's plan.
- **Permissions:** local SDK runs auto-approve tool calls; Letta's per-tool
  approvals do not apply. Only delegate work you authorize the worker to
  perform.
- **Steering:** `run.steer()` is local-only; Cursor-hosted cloud agents accept
  only follow-ups (`Agent.resume(...)` then `send(...)`). In-flight message
  ownership transfers only on `complete_delivered`; a declined steer becomes a
  serialized follow-up turn after the current run — deliver exactly once.
  Report an unknown acknowledgment as unknown rather than retrying it.
  Cancelling a queued follow-up does not cancel its predecessor. Follow-ups
  preserve the original checkout, model, and MCP discovery reminder.
- **Packaging:** the SDK ships platform binaries and persistence; keep it in
  the worker process, not loaded into Letta's main process.
- **Cloud execution:** Cursor-hosted VMs introduce a separate checkout,
  credential, and change-return lifecycle. Version one is local execution on
  the selected computer; do not silently replace the existing
  `computer: "cloud"` semantics with Cursor hosting.

## Model handles

New sessions require an explicit Cursor model ID. Handles come from Cursor's
own catalog — `Cursor.models.list()` with the worker's API key — not from the
Letta model catalog and not from `letta model list`, which lists only the Letta
backend's models (see the `adding-models` skill). The catalog includes a
`default`/Auto entry. Other external workers avoid requiring model discovery by
relying on their configured defaults, so test omitting `model` before treating
the explicit-ID requirement as permanent. Discovery must run with the same
computer and account as execution — never list one sandbox's models for a
worker running elsewhere.

## Testing

The live lifecycle suite exercises the real SDK: file edits and streamed tool
progress, history and original-checkout preservation through
`SendAgentMessage`, exactly-once in-flight messaging, `TaskStop` terminating
the worker shell, and packaged Node continuation across worker-process exits.

- A real `CURSOR_API_KEY` is required both in the agent vault and as the
  repository CI secret; without it no provider tests run and the CI job fails
  at setup.
- Verify authentication-failure handling under both the Bun source path and
  the built Node artifact.
- The Cursor CI job needs a ~20-minute ceiling: three 180-second live bun
  tests plus a full `bun run build`.

## Why this works / why it will be useful again

Every piece of future Cursor work touches the same Agent() external-worker
contract, SDK steering semantics, credential source, and catalog boundary.
Recording them here lets a future agent extend or fix the worker without
re-deriving the architecture from the PR and Cursor SDK docs.
