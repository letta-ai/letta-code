---
name: private-reflection-runtime
description: Runs Letta Code reflections on a private, agent-free, per-conversation runtime and keeps them isolated from global and project memory. Use when implementing or reviewing the runtime side of private dreaming / per-DM private memory — resuming an existing agent-free conversation without creating an agent, enforcing that a private run never resolves, prompts, or publishes to global/project targets, or gating harness-side private repository discovery, caching, and sync.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-d159d3d9-722c-4fc5-a2d5-e727acc569f2"]'
  rationale: 'The source trajectory established that private-target behavior cannot be achieved by aliasing an attached repository: runtime target resolution, target injection, and every fetch/push/completion consumer must honor private mode, and execution must use the agent-free conversation resume path. Future letta-code work on private DM memory must preserve these boundaries, which no existing skill or AGENTS.md section captures.'
---

# Private Reflection Runtime

Private reflection (per-DM / per-conversation dreaming) runs inside the Letta
Code App Server runtime as an **agent-free conversation**: the runtime scope has
`agent_id: null` and execution is resumed by `conversation_id` only.

## Agent-free runtime surface

Verified at HEAD in `src/types/runtime-start-protocol.ts` and
`src/websocket/app-server-agent-free.integration.test.ts`:

- `runtime_start` accepts either `create_conversation` with body `{ model, system }`
  (create an agent-free conversation) or `conversation_id` (resume an existing
  one). Both are mutually exclusive with `agent_id` / `create_agent`.
- Response: `agent: null`, `created: { agent: false, conversation: <bool> }`,
  and `runtime.agent_id` is null (`ConversationRuntimeScope` in
  `src/types/runtime-scope.ts`).

Private execution resumes the scoped child with `conversation_id` only; it never
passes `create_agent`, `agent_id`, or generic dream/session creation. The client
entry point on this branch is `query({ prompt, options: { conversationId, model,
system, ... } })` (SDK >= 0.8.20). Do not use `resumeSession(conversationId)`:
older SDK versions still require `agent_id`, so they cannot resume an
agent-free child.

## Isolation invariants

- Private mode must be honored by **every** consumer of the run — repository
  fetch/push, completion scope, prompt target selection, and URL resolution —
  not just claim output. A private run keeps the private repo as its sole
  target and never falls back to global or project targets (no-target URLs
  resolve to the global repo; planner injection adds canonical project targets).
- Aliasing the private repo behind an attached repository is not sufficient:
  normal target resolution still injects project targets and global prompts
  without an explicit private-mode branch.
- Conversation-scoped prompt projection is not filesystem isolation: a local
  caller able to read the DM conversation can see its projected private prompt;
  Git/list/mount access to the private repo is a separate authorization gate.

## Harness-side private discovery, cache, and sync

The harness (letta-code client/runtime) is in scope for DM-private
repositories. Gate every private-handling path on the managed cloud runtime
marker `LETTA_MANAGED_CLOUD_RUNTIME=1` — never `LETTA_SANDBOX`, which means OS
sandbox — and treat the server-proven `conversation_id` on a repository
descriptor as the only scope a private checkout may carry:

- Discovery (`listAttachedAgentRepositories`): reject or hide private
  descriptors outside the managed cloud runtime; inside one, preserve the
  descriptor's `conversation_id` as the checkout scope. Never downgrade a
  malformed private scope (missing, empty, or non-string `conversation_id`)
  into a shared repository.
- Shared skill-discovery cache (`resolveSharedMemorySkillsContext`): scope by
  runtime conversation plus managed/local, invalidate per conversation, and
  filter explicitly injected descriptor lists too — one DM's private skill
  discovery must never surface in another conversation.
- Direct post-turn sync (`syncPendingAttachedRepositoryCommits`): refuse or skip
  private checkouts outside the managed cloud runtime.
- These checks are client-side gating, not authentication: the cloud must still
  verify the credential's conversation binding and sandbox-only access to the
  private repo.

Until this gating lands and is validated, the private capability stays
disabled; private descriptors must never be treated as shared in the meantime.

## Why this works / why it will be useful again

Private target behavior cannot be faked by repo aliasing: the executor, target
injection, and all fetch/push/completion consumers must honor private mode, and
the run must execute through the agent-free conversation resume path so no
generic agent or global/project memory is ever consulted. The same holds on the
harness side: private repository discovery, skill caches, and post-turn sync
must be gated to the managed runtime so a DM-private repo never surfaces outside
its conversation. This cross-repo finding took a full investigation to
establish; future letta-code work on private dreaming needs these invariants
without repeating that search.
