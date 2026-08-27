---
name: migrating-memory
description: Migrate memory from an existing agent into the current agent. Use when the user wants to copy, upgrade, or share memory and Agent Skills between agents.
---

# Migrating Memory

Use a dry-run-first workflow. Never overwrite the current memory repo or copy another repo's `.git`, hooks, remotes, or harness metadata.

## Identify the active layout

Read the current system prompt before moving files:

- **Agent Memory:** root Markdown is core memory, nested memory uses `MEMORY.md` indexes, and `skills/` follows Agent Skills.
- **Legacy MemFS:** `system/` Markdown is always loaded and other Markdown is external.

The local Agent Memory staging path is enabled with `LETTA_LOCAL_AGENT_MEMORY=1`. Keep the source unchanged until the converted target has been compiled and inspected.

## Locate the source

For another local agent, its memory normally lives under the local backend storage directory. Resolve the path from the local agent ID rather than guessing.

For an API-backed agent, export its memory to a temporary directory:

```bash
letta memory export --agent <source-agent-id> --out /tmp/letta-memory-<source-agent-id>
```

If the user does not know the source agent ID, load the `finding-agents` skill first.

## Convert legacy Letta Code memory to Agent Memory

Use the reference converter from a temporary checkout. Both converter invocations leave the source untouched.

```bash
git clone --depth 1 https://github.com/agent-memory-spec/agent-memory /tmp/agent-memory-spec
uv run --project /tmp/agent-memory-spec/memory-ref memory-ref migrate-from letta-code \
  <source-memory-dir> --output /tmp/converted-agent-memory
```

Review the dry run. Confirm that:

- `.git` and hidden harness state are excluded;
- `skills/` is preserved unchanged but is not indexed as memory;
- promoted `system/` links are rewritten;
- the reported root token count is acceptable;
- no destination collision is unresolved.

Apply only after that review:

```bash
uv run --project /tmp/agent-memory-spec/memory-ref memory-ref migrate-from letta-code \
  <source-memory-dir> --output /tmp/converted-agent-memory --apply
uv run --project /tmp/agent-memory-spec/memory-ref memory-ref validate \
  /tmp/converted-agent-memory
```

## Merge into the current agent

1. Require a clean `$MEMORY_DIR` git working tree.
2. Compare every root-file collision. Merge identity and user files by meaning rather than blindly replacing them.
3. Copy nested memory directories and `skills/` only after checking name collisions.
4. Keep every required `MEMORY.md` index.
5. Search for stale `[[system/...]]` links and references to removed paths.
6. Stage explicit files, review the diff, and commit once with the agent identity. Local memory is committed but not pushed to a Letta API remote.
7. Recompile the current conversation and inspect the compiled prompt. Confirm root files are present, nested detail is absent, immediate child memory directories are surfaced, and skills appear only through the Skill system.

Do not delete the source or temporary conversion until the migrated agent has completed a successful turn with the new prompt.

## Legacy destination

If the destination still uses legacy MemFS, retain its existing `system/` and frontmatter rules. Do not place Agent Memory root files into a legacy prompt compiler and assume they will load.
