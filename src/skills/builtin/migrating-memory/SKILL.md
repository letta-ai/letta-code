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
- Review the prepared memory in order: flatten `system/` and repair its cross-links first, then write the `MEMORY.md` indexes for the resulting layout.
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

Review the prepared tree in this order. Do not write the indexes against the old `system/` layout and then flatten it afterward.

#### 4a. Flatten `system/` and repair links

Inspect every entry in the stage report's `flattened` list. Confirm that every committed file under `system/` has a corresponding root-level destination and that no source file was omitted. Treat the prepared flattened files as the canonical layout for all remaining review work.

Review links after the move. Update every relative Markdown link, reference-style link, and wiki link that pointed into `system/` so it points to the flattened destination. Also update links between moved files when their relative locations changed. Do not leave old `system/...` paths behind unless they are literal historical examples rather than navigational links.

Fix generated names and TODO descriptions on the flattened tree before generating index content. Every memory Markdown file other than `MEMORY.md` has exactly `name` and `description` frontmatter.

#### 4b. Generate the `MEMORY.md` hierarchy

Only after the flattened paths and cross-links are final, replace every generated `MEMORY.md` placeholder with the index for that directory's final contents. `MEMORY.md` has no frontmatter.

Every memory file must be represented by a link in the nearest `MEMORY.md`: a root file belongs in root `MEMORY.md`, while a nested file belongs in the `MEMORY.md` in its containing directory. Every child memory directory must likewise be represented in its parent's `MEMORY.md` by a link to the child's `MEMORY.md`. This is exhaustive inventory, not a curated subset. `skills/` is excluded because Agent Skills are discovered separately and its prepared contents must remain unchanged.

The index and frontmatter descriptions have different jobs. A `MEMORY.md` routing note tells the agent what exists and why it might open that file before loading it. Keep it terse. A file's frontmatter description briefly explains what the file contains once selected. Do not copy the frontmatter description into the index. Do not narrate the migration, conversion, source agent, or review process in the index; describe the memory as it exists now while preserving source content that genuinely concerns those subjects.

Use this as an in-context example of the distinction, not as a rigid template. Adapt the links, prose, and cross-references to the memory being migrated:

```markdown
# Memory

- [Human](human.md) - Who I'm working with
- [Persona](persona.md) - Who I am and how I act
- [Projects](projects/MEMORY.md) - Project-specific memory
```

```yaml
---
name: "Human"
description: "Durable context about the person I work with."
---
```

#### 4c. Verify the complete tree

Before running the validator, inspect the entire prepared tree and verify all of the following:

- Every memory directory, including the root and every nested directory outside `skills/`, contains a `MEMORY.md`.
- Every memory Markdown file is linked exactly once from the nearest `MEMORY.md`.
- Every child memory directory is linked from its parent index through the child's `MEMORY.md`.
- Every local Markdown link, reference-style link, and wiki link resolves to a real prepared file after accounting for its source file's directory. There are no stale `system/` destinations.
- Every original committed `system/` file appears in the `flattened` report and exists at the reported destination.
- Every non-skill Markdown file has valid V2 frontmatter, while every `MEMORY.md` has none.
- The prepared `skills/` tree is byte-for-byte unchanged from the committed source.

If any check fails, fix the prepared tree and repeat the complete verification. Do not apply a migration with an incomplete index or a broken local cross-link.

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
