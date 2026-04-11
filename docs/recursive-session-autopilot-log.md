# Recursive Session Experiment — Autopilot Log

This document records autonomous decisions, progress, and audit notes from the autopilot execution of the remaining experiment phases.

---

## Phase 1: Enable Recursive Delegation

**Status:** Complete

### Goals
- Enable intentional recursive delegation in Letta Code
- Add explicit depth tracking with a configurable safety limit
- Add advisory budget propagation
- Add regression tests for recursion and guardrails

### Implementation Summary

1. **Recursion policy (1B):** Added `Task` tool to `general-purpose` and `fork` built-in subagent configs. Kept `explore` non-recursive. Left other built-ins unchanged.

2. **Depth tracking + safety limit (1C):** Added three env-based metadata variables propagated through the child process spawn path:
   - `LETTA_TASK_DEPTH` — current recursion depth (incremented on each spawn)
   - `LETTA_TASK_MAX_DEPTH` — configurable cap (defaults to 5)
   - Enforcement in `Task.ts` rejects delegation when depth >= max depth

3. **Budget propagation (1D):** Added advisory budget model:
   - `LETTA_TASK_BUDGET_TOKENS` propagated through child env
   - Explicit `budget_tokens` parameter on Task schema to override inherited budget
   - Budget and depth metadata surfaced in transcript headers and result headers
   - No hard budget enforcement in Phase 1

4. **Tests (1E):** Added targeted tests in three files:
   - `src/tests/agent/subagent-builtins.test.ts` — recursive delegation tool policy
   - `src/tests/agent/subagent-model-resolution.test.ts` — child env propagation, depth, budget
   - `src/tests/tools/task-recursion.test.ts` — recursion metadata derivation and limit enforcement

### Autonomous Decisions

| Decision | Rationale |
|----------|-----------|
| Env-based metadata over CLI args | Subagents are spawned as child processes; env is already the mechanism for runtime context propagation |
| Default max depth of 5 | Matches the design doc template; conservative enough to prevent runaway recursion while allowing meaningful decomposition |
| Advisory-only budget for Phase 1 | Full tree accounting and hard enforcement are out of scope; advisory budget gives the model information to make decisions without adding complex cross-process state |
| `buildSubagentChildEnv` extraction | The original inline env construction in `executeSubagent` was growing; extracting it into a testable pure function improved both clarity and testability |
| Keep `build.js` changes separate | The `build.js` diff (target: bun, shebang change) is unrelated to this experiment and should not be included in the Phase 1 commit |

### Validation
- All targeted tests pass (39 tests across 3 files)
- `bun run typecheck` passes

### Files Changed
- `src/agent/subagents/builtin/general-purpose.md` — added Task to tools
- `src/agent/subagents/builtin/fork.md` — added Task to tools
- `src/agent/subagents/manager.ts` — depth/budget env helpers, `buildSubagentChildEnv`, `budgetTokens` param threading
- `src/tools/impl/Task.ts` — recursion check, metadata helpers, depth/budget in headers/transcripts
- `src/tools/schemas/Task.json` — `budget_tokens` property
- `src/tools/descriptions/Task.md` — recursion + budget docs
- `src/tests/agent/subagent-builtins.test.ts` — recursion policy test
- `src/tests/agent/subagent-model-resolution.test.ts` — child env tests
- `src/tests/tools/task-recursion.test.ts` — new recursion metadata tests

---

## Phase 2: Decomposition Skill + Pilot Prompt

**Status:** Pending

### Goals
- Create the recursive-session SKILL.md
- Write pilot identity and decomposition memory seeds
- Test decomposition decision framework

---

## Phase 3: Memory-Based Learning

**Status:** Pending

### Goals
- Build sleep-time consolidation prompt
- Wire as post-session hook or command
- Test that memory evolves across sessions
