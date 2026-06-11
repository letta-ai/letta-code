# FS Sandbox — extending to the local backend

Branch `worktree-fs-sandbox`. Feature gated behind `LETTA_FS_SANDBOX=1`, default
OFF. This plan extends the sandbox from **API/cloud-backend** agents to
**local-backend** agents and subagents (`LETTA_LOCAL_BACKEND_EXPERIMENTAL=1`).

---

## Status

**Cross-agent read-deny + `~/.letta`-scoped writes — DONE on both surfaces.**
Memory subagents (both backends) scope writes to the harness state dir `~/.letta`:
they may persist memory + harness metadata (settings, logs, conversations,
transcripts) anywhere under it, but NOT the repo/home/temp, and the cross-agent
tree nested inside `~/.letta` stays denied. Parent shells get cross-agent
isolation against the local `memfs` tree. Shipped:

- **L1** — `buildMemoryModeSandboxPolicy` parameterized with `agentsTreeRoot?`
  (defaults preserve cloud behavior); writes scoped via a new `baseWritableRoots`
  policy phase = `~/.letta` (see "Write posture" below).
- **L2** — parent shells wall off the local `memfs` tree when
  `isLocalBackendEnvEnabled(env)` (`shell-sandbox.ts`), resolved *after* the gate
  so the sandbox-off hot path does no fs work.
- **L3** — `wrapSubagentLauncher` no longer skips local; it builds the memory-mode
  policy against the `memfs` tree, with `~/.letta` as the writable base (plus any
  harness root relocated outside `~/.letta` via `harnessWritableRoots`).
- The backend→tree branching is single-sourced in
  `getLocalBackendCrossAgentTreeRoot()` (`backend/local/paths.ts`); the builders
  stay in `permissions/` and take a resolved path (they cannot import `backend/`).
- **`willSandboxParentShell` was intentionally NOT changed:** the parent cwd is
  always the repo (outside both trees), so its default-tree empty-env check stays
  correct. Kept the diff minimal.

Validated: unit tests, full `bun run check`, and `sandbox-local-backend-live-test.ts`
on Seatbelt (both surfaces — other-agent memory read+write denied, self memory +
~/.letta harness writes work, env survives cwd-in-tree, repo/`/tmp` writes denied
for subagents) + L5 real run (settings/transcripts persist, no swallowed failure).
**Remaining:** the Linux/bwrap host run (separate handoff). L5 (a real local turn
with a reflection subagent) is ✅ done — see below.

---

## Why local isn't covered today

Everything we built — the static cross-agent guard *and* every sandbox policy —
keys on **`~/.letta/agents`**. Local-backend memory does not live there:

| | Memory location | Other on-disk state |
|---|---|---|
| API / cloud | `~/.letta/agents/<id>/memory` | conversations are server-side |
| **Local** | `~/.letta/lc-local-backend/memfs/<id>/memory` | `agents/<enc-id>.json`, `conversations/<enc-conv-key>/`, `providers/auth.json` — **all on disk, one storage dir** |

So on local backend right now:

- **Subagents** are *explicitly skipped*: `wrapSubagentLauncher` bails on
  `input.backendMode === "local"` (`src/agent/subagents/sandbox.ts:65`). No
  kernel confinement at all.
- **Parent shells** *are* wrapped (the parent shell sandbox is not
  backend-gated), but the policy denies `~/.letta/agents` — empty/unused on
  local — and leaves `lc-local-backend` fully writable. Net: a **harmless no-op
  for protection** (no cross-agent isolation) that also **doesn't break**
  anything.

This means cross-agent isolation for local agents is **absent in both the old
and new world** — a pre-existing gap, not a regression. This plan closes it.

---

## The core complication (read before designing)

A local subagent child runs the local backend **in-process** and persists its
**own** conversation + agent-state to the shared storage dir
(`local-store.ts:1263` writes `agents/<enc-id>.json`; `local-store.ts:2887+`
writes `conversations/<enc-conv-key>/`). The API memory-mode policy uses
`restrictWrites:true` scoped to the memory dir — which works on API only because
API persistence is server-side. **Applied to a local child, `restrictWrites`
would deny its conversation + state writes and break it.**

Two consequences drive the design:

1. **v1 must not naively reuse `restrictWrites:true` memory-only** for local
   subagents. Either drop write-restriction (deny-list only) or carve the
   self conversation + state paths (hard — see below).
2. **Conversations have no per-agent path boundary.** Conversation dirs are named
   by *conversation key* (`encodePathSegment("conversation:local-conv-2")`), not
   agent id, so you cannot carve "self's conversations" or deny "other agents'
   conversations" by path prefix. Agent-state files *are* per-agent
   (`agents/<enc-id>.json`) and tractable. **Cross-agent memory maps cleanly;
   cross-agent conversation does not** — keep v1 scoped to memory.

---

## Design

### Backend-aware tree resolution (the one shared primitive)

Introduce a single notion of "the memfs tree to wall off" + "this agent's own
dir inside it", resolved per backend:

| | tree root (deny) | self dir (carve) |
|---|---|---|
| API | `~/.letta/agents` | `~/.letta/agents/<id>` |
| Local | `~/.letta/lc-local-backend/memfs` | `~/.letta/lc-local-backend/memfs/<id>` |

**Layer constraint:** `permissions/sandbox-policy.ts` and
`permissions/sandbox-gate.ts` cannot import `backend/local/paths.ts`
(`permissions` is below `backend`). So:

- The policy builders already accept an explicit `agentsTreeRoot`
  (`buildCrossAgentSandboxPolicy`). Add the same param to
  `buildMemoryModeSandboxPolicy` (today it hardcodes `getDefaultAgentsTreeRoot()`
  at `sandbox-policy.ts:134`).
- Compute the local tree root + self dir in the **caller's layer**
  (`tools/` for parent shells, `agent/` for subagents — both may import
  `backend/`) via `getLocalBackendStorageDir()` +
  `getLocalBackendMemoryFilesystemRoot()`, and pass them down.
- Extend `willSandboxParentShell(cwd, env, availability, treeRoot?)` with an
  optional injected tree root so the cwd-inside-tree empty-env check uses the
  right tree. Tools-layer caller passes the local tree; the permissions-layer
  guard keeps the API default (the guard has no local rules to defer anyway —
  local memory was never under `~/.letta/agents`).

### Policy shapes

**Parent shells (local cross-agent)** — direct analog of the API parent policy,
pointed at the local tree. Parent cwd is the repo (outside the tree), so no
empty-env risk:
```
deniedRoots:  [lc-local-backend/memfs]
writableRoots:[lc-local-backend/memfs/<self>]   // carve self
restrictWrites:false                            // only the tree is walled off
```
Parent process persistence (conversations/agents) happens in the *unsandboxed
parent process*, not in the wrapped shell, so it's unaffected.

**Subagents (local memory-mode), `restrictWrites:true` scoped to `~/.letta`** (the
SHIPPED shape — supersedes both the original `restrictWrites:false` deny-list and
the intermediate per-dir harness enumeration). The child's cwd is
`memfs/<self>/memory` (inside the denied tree), so it needs the agent-dir
readonly carve for env survival (identical to the API empty-env fix):
```
baseWritableRoots:[~/.letta]                                // harness state writable (emitted BEFORE the deny)
deniedRoots:      [lc-local-backend/memfs]                  // cross-agent tree (overrides the base)
readonlyRoots:    [lc-local-backend/memfs/<self>]           // traversal + env survival + own reads
writableRoots:    [lc-local-backend/memfs/<self>/memory]    // self memory re-carved (overrides the deny)
restrictWrites:   true                                      // everything outside the above denied
```
This delivers BOTH the cross-agent read-deny (another agent's memory read- and
write-denied) AND write-scoping: the agent's non-deterministic work can write
under `~/.letta` (memory + harness metadata) but NOT the repo/home/temp. Carving
the WHOLE `~/.letta` rather than enumerating each harness file is what makes it
robust — the harness writes many unbounded paths under it (settings via
`setMemfsEnabled` on startup, logs, conversations, transcripts), and a per-file
carve silently breaks (a swallowed `Failed to persist settings`) as new writers
appear. The cross-agent tree nested inside `~/.letta` is the only thing walled
off; self memory (also nested) is re-carved. `harnessWritableRoots` covers a
storage/transcript root relocated OUTSIDE `~/.letta` (env overrides).

---

## Sequenced steps

### L0 — No-regression baseline (do first, cheap)
Confirm that *wrapping a local agent at all* doesn't break it, before adding any
denies. Add a local variant of `scripts/sandbox-bash-live-test.ts` that builds a
fake `lc-local-backend/{memfs,conversations,agents,providers}` layout under a
throwaway `HOME`, drives `applyParentShellSandbox` with the **current** (API)
policy, and asserts: env intact, repo+tmp+`lc-local-backend` writes succeed,
shell runs. Establishes the floor.

### L1 — Backend-aware tree primitive ✅ DONE
- Added `agentsTreeRoot?` to `buildMemoryModeSandboxPolicy` (a `restrictWrites?`
  param was added then removed once parity landed — both backends restrict).
- **Did NOT** add `treeRoot` to `willSandboxParentShell` — unnecessary (parent cwd
  is the repo, outside both trees; the default-tree check is correct either way).
- The helper is `getLocalBackendCrossAgentTreeRoot()` in `backend/local/paths.ts`
  (returns `<storage>/memfs`). It does not need the API branch: callers omit
  `agentsTreeRoot` for API and the builder defaults to `~/.letta/agents`.

### L2 — Parent shells on local ✅ DONE
- `applyParentShellSandbox` (`src/tools/impl/shell-sandbox.ts`) detects local via
  `isLocalBackendEnvEnabled(env)` (no need to thread `backendMode` through the 3
  call sites — the env already carries it) and walls off
  `getLocalBackendCrossAgentTreeRoot()` instead of `getDefaultAgentsTreeRoot()`.
  Resolved after the gate so the hot path stays fs-free.
- Live-validated in `sandbox-local-backend-live-test.ts` (parent surface): other
  agent's memory read+write denied, self memory + repo writable, env intact.

### L3 — Subagents on local ✅ DONE
- Removed the `if (input.backendMode === "local") return null;` short-circuit.
  Local builds the memory-mode policy against the `memfs` tree with
  `restrictWrites:true` (write-scoped, same as API) and carves the harness
  persistence dirs via `extraWritableRoots` so the in-process child isn't
  trapped (see Phase 3 below).
- `wrapSubagentLauncher` gained `localBackendStorageDir?`; `manager.ts` forwards
  the value it already computes.
- Live-validated in `sandbox-local-backend-live-test.ts` (subagent surface): env
  survives, self memory read+write OK, **other agent memory read+write DENIED**,
  **repo + /tmp writes DENIED** (write-scoping), and conversation/agent-state/
  providers/transcript writes **succeed** (child not trapped).

### L4 — Guard coordination + flag-off invariants
- Confirm the static guard still no-ops correctly for local (it keys on
  `~/.letta/agents`, so it has nothing to defer/skip for local memory; the
  kernel is sole enforcement). No guard change expected — assert it in a test.
- Re-run the full `bun run check`; verify every flag-OFF path is unchanged
  (`isFsSandboxEnabled` short-circuits remain the first check everywhere).

### L5 — Real local turn ✅ DONE
Validated by `scripts/sandbox-l5-local-reflection.ts`: a real local-backend
bidirectional session (`LETTA_FS_SANDBOX=1`, Anthropic provider, throwaway HOME,
`--reflection-step-count 1`) that forces a **real reflection subagent** to fire.
Confirmed on Seatbelt: the reflection child was actually sandboxed (`memory-mode
child sandboxed via seatbelt`), ran to completion with **no trap** (no EPERM /
"operation not permitted" anywhere), persisted its own agent-state (a 2nd
`agents/` record), the parent's memory edits committed to memfs (init + 2 edits),
and transcript files were written — proving the carved harness write-set
(conversations/agents/providers + transcript root) is complete under
`restrictWrites:true`. (Note: `openai/gpt-5-mini` returned a non-retryable
`llm_error` via the local pi-ai path — unrelated to the sandbox; Anthropic is the
working provider for this run.)

---

## Phase 3 — Write-scoping (writes confined to `~/.letta`) ✅ DONE

Memory subagents on BOTH backends run `restrictWrites:true` with `~/.letta` as
the writable base (new `baseWritableRoots` policy phase, emitted before the
cross-agent deny so the nested tree still wins). The agent's non-deterministic
work can write under `~/.letta` (memory + all harness metadata) but not the
repo/home/temp.

This **supersedes** the earlier per-dir harness enumeration
(`lc-local-backend/{conversations,agents,providers}` + transcript via
`extraWritableRoots`). That approach was brittle: the harness writes an unbounded
set of paths under `~/.letta` — notably `~/.letta/.lettasettings` on the headless
startup path (`setMemfsEnabled`, `headless.ts:1390`), whose denial was swallowed
as a `Failed to persist settings` + `settings_persist_failed` boundary error.
Carving the whole `~/.letta` (minus the cross-agent tree) fixes that class
entirely without enumeration. Can't carve `~/.letta` via plain `writableRoots`
(it would override the nested cross-agent deny — and trips the bwrap ancestor
hazard); the `baseWritableRoots` phase exists precisely to emit it BEFORE the deny
so the deny still masks the tree. The `restrictWrites` param was removed (always
true for memory mode). Validated by L5 (no swallowed settings failure).

## Out of scope (call out explicitly, don't silently skip)

- **Cross-agent conversation / agent-state isolation** — a *new* exposure on
  local backend that doesn't exist on API (where conversations are server-side).
  Memory is isolated; conversation/state reads (and, since the harness carve,
  writes) of other agents are not, because there's no per-agent path prefix for
  conversations. Genuinely harder; separate investigation.

## Risks / gotchas

- **`getMemoryFilesystemRoot` is not backend-aware** (`memory-filesystem.ts:43`)
  and `resolveAllowedMemoryRoots` falls back to it. On local, ensure the memory
  roots feeding the policy resolve to the `lc-local-backend/memfs/<id>/memory`
  path (via `MEMORY_DIR`, which the subagent path already sets through
  `resolveSubagentInheritedPrimaryRoot` at `manager.ts:785`) — not the unused
  API path. Verify for the *parent* local agent too (does it set `MEMORY_DIR`?).
- **`providers/auth.json` must stay readable** by the local child (it may read
  provider creds). The memory-mode deny only walls off `memfs`, so
  `lc-local-backend/providers` stays readable — good; assert it in the live test.
- **Empty-env** transfers from API: the local subagent cwd is inside the denied
  `memfs` tree, so the `memfs/<self>` readonly carve is load-bearing. The
  existing `deriveSelfAgentRoots` logic already produces the agent dir from a
  `/memory` leaf — confirm it does so for the local path shape too (leaf is
  `memory`, parent is `memfs/<id>` ✓).
- **Don't flip `LETTA_FS_SANDBOX` on by default.** All work stays flag-gated.
- **Keep Seatbelt + bwrap parity.** Any policy change must work on both; the
  bwrap host run (separate handoff) covers Linux.
