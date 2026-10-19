---
name: reflection-worker-orchestration
description: Decides how Letta Code should launch parallel reflection subagents over a transcript corpus. Use when orchestrating a reflection dream or batch-reflection loop and you must choose between the Agent tool and Workflow agent(), or between the built-in reflection subagent and a custom worker definition.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-8604cc1e-260e-4b03-9762-2003f7bf50f5"]'
  rationale: 'A reflection-orchestration run twice built custom machinery (a custom reflection-worker subagent, a reflect.js workflow runner, skill-inlining and worktree/merge scripts) before establishing that Letta Code already ships a built-in reflection subagent and that Workflow agent() cannot preload skills or launch named subagent types. A future agent would otherwise re-derive these invariants from reflection-v2.md frontmatter, the subagent manager, and sdk-spawner.ts.'
---

# Reflection Worker Orchestration

Use this when you need many reflection passes over transcripts and must decide how
Letta Code launches the workers.

## Reuse the built-in reflection subagent

Letta Code bundles a `reflection` subagent (`src/agent/subagents/builtin/reflection-v2.md`)
that is already a usable reflection worker:

- Tools: `Bash`, `Edit`
- Preloaded skills (frontmatter `skills:` -> harness `--pre-load-skills`):
  `creating-skills`, `maintaining-core-memory`, `maintaining-deferred-memory`
- Writes to the parent agent's memory (`$MEMORY_DIR`), i.e. the reflection target.

Launch it directly with the Agent tool: `Agent(subagent_type: "reflection", prompt: "...")`,
passing the transcript paths and a focus in `prompt`. Do not build a custom subagent type,
skill-inlining script, or worktree/merge layer just to reproduce this — the built-in already does it.

## Agent() vs Workflow agent()

- `Agent(subagent_type: ...)` launches a named subagent type and honors its preloaded
  skills. Use this when workers need skills preloaded.
- Workflow `agent()` (`src/tools/workflow/sdk-spawner.ts`) cannot launch a named subagent
  type and cannot preload skills (`skillSources` is hard-coded empty). Its options are
  limited to `systemPrompt`, `allowedTools`, `model`, `effort`, `timeoutMs`,
  `maxToolCalls`, `json`, `schema`. To reproduce built-in reflection inputs on this path,
  inline the reflection body as `systemPrompt` and the preloaded skill texts as
  `<loaded_skills>` in the task yourself.
- Workflow workers are ephemeral parent-linked conversations, not separate agents;
  `Agent()` creates a hidden agent per worker.

## Concurrency caveat

Reflection workers commit into the same memory checkout (`git add -A` + commit).
Multiple parallel workers on one checkout can collide on `git add`/commit and sweep up
each other's edits. They usually touch different files, but it is not guaranteed. Either
run workers in small batches or give each worker its own memory worktree/repository and
merge afterwards.

## Why this works / why it will be useful again

A reflection-orchestrated dream invested in a custom `reflection-worker` subagent, a
`reflect.js` workflow runner, and worktree/merge machinery, and only later established
that Letta Code main already ships a built-in `reflection` subagent with Bash+Edit, the
three memory/skill skills preloaded, and writes to the parent's `$MEMORY_DIR` — and that
Workflow `agent()` cannot preload skills or launch named subagent types. Any future agent
fanning reflection workers over a transcript corpus will hit the same forks, so these
codebase invariants are worth stating once: reuse `Agent(subagent_type: "reflection")`,
fall back to Workflow only with manual skill inlining, and batch workers to avoid
same-checkout commit races.
