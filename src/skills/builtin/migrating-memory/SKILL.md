---
name: migrating-memory
description: Migrate committed memory from a Cloud or local source into the current agent, or upgrade the current agent's repository to MemFS v2.
---

# Migrating Memory

Run this workflow from the target agent. Treat source and target as independent endpoints: each has its own backend, agent ID, and memory repository. The same process covers local to local and Cloud to local now. It will cover Cloud targets when Cloud supports MemFS v2 compilation.

This migrates memory files and Agent Skills. It does not migrate conversations, credentials, provider settings, or other agent configuration.

The conversion workflow below is a full migration: applying it replaces the target's committed memory tree with the reviewed source tree.

## Selective sharing

If the user wants only selected memories, stop before staging the conversion. Pull and export the source as described below, inspect the target's current layout, then use the memory tools to add or merge only the chosen files. Preserve the target's format and existing indexes. Do not run the converter's `apply` command for a selective migration.

## Safety rules

- Identify the source backend, source agent ID, target backend, and target agent ID before changing files.
- The current `$MEMORY_DIR` and `$AGENT_ID` are the target. If the intended target is another agent, open that agent before continuing.
- Work from committed source and target repositories. Resolve dirty files before staging.
- Stage the conversion in a separate review directory. Leave the source and target repositories unchanged during review.
- Inspect every generated `MEMORY.md` and TODO description.
- Inspect every added, modified, and deleted path in `target_changes`. Stop if any target deletion is unexpected.
- Replace generated index text with short overviews and relative Markdown links before applying.
- Keep the prepared `skills/` tree unchanged from the source.
- Apply only after validation passes.

## Workflow

### 1. Record the target

```text
TARGET_AGENT_ID="$AGENT_ID"
TARGET_MEMORY_DIR="$MEMORY_DIR"
TARGET_BACKEND="local" # or "cloud" when Cloud v2 activation is available
```

A local target agent ID starts with `agent-local-`. A Cloud target uses `agent-`. Cloud sources are supported now. Stop if the target is Cloud because this release cannot compile MemFS v2 for a Cloud agent yet.

### 2. Materialize the source repository

If the current agent is upgrading itself, use `$MEMORY_DIR` as `SOURCE_MEMORY_DIR`.

If the source agent ID or backend is unknown, invoke the `finding-agents` skill. Run its lookup with an explicit `--backend cloud` or `--backend local`; search both when the user has not said where the source lives.

For another source agent, choose a new empty export directory, then pull and export through that source's backend:

```text
letta --backend "<SOURCE_BACKEND>" memory pull --agent "<SOURCE_AGENT_ID>"
letta --backend "<SOURCE_BACKEND>" memory export --agent "<SOURCE_AGENT_ID>" --out "<SOURCE_EXPORT_DIR>"
```

`SOURCE_BACKEND` is `cloud` or `local`. Use the exported directory as `SOURCE_MEMORY_DIR`. Do not infer the source backend from the target.

### 3. Stage a reviewed v2 tree

Choose a new absolute review directory outside both repositories, then run:

```text
node "<SKILL_DIR>/scripts/memfs-v2.mjs" stage --source "<SOURCE_MEMORY_DIR>" --target "$TARGET_MEMORY_DIR" --output "<REVIEW_DIR>"
```

The adjacent manifest records both repository paths and commits. The report includes `target_changes` for the full replacement. Apply will refuse if either repository changes after staging or if the target contains ignored files that replacement would delete.

### 4. Review and validate

Fix generated names, TODO descriptions, overview text, and links. `MEMORY.md` has no frontmatter. Every other memory Markdown file has exactly `name` and `description` frontmatter.

```text
node "<SKILL_DIR>/scripts/memfs-v2.mjs" validate --prepared "<REVIEW_DIR>"
```

Read the validation output again after editing. It recalculates `target_changes`; confirm every deletion before applying.

### 5. Apply to the target

```text
node "<SKILL_DIR>/scripts/memfs-v2.mjs" apply --prepared "<REVIEW_DIR>" --target "$TARGET_MEMORY_DIR" --target-agent "$TARGET_AGENT_ID" --target-backend "$TARGET_BACKEND"
```

Before changing files, apply asks the selected target backend to verify the agent, repository path, and managed prompt. It then replaces and commits the target tree and asks that backend to activate MemFS v2. Local activation adds the tag and updates a recognized managed prompt to the v2 variant. If preflight rejects a custom prompt, replace or adapt that prompt before staging a fresh review tree.

### 6. Recompile the target

Ask the user to run `/recompile` on the target agent. Keep the review directory and its adjacent manifest until activation and recompile succeed.
