---
name: upgrading-memory-filesystem
description: Convert an untagged local agent's committed memory repository to the root-first MemFS v2 layout.
disable-model-invocation: false
---

# Upgrade the local memory filesystem

Use this skill only for the current local agent. It disappears after the agent receives the `memfs-v2` tag.

## Safety rules

- Work from the committed memory tree. If `$MEMORY_DIR` is dirty, stop and resolve those edits first.
- Stage the conversion in a separate review directory. Do not edit `$MEMORY_DIR` during review.
- Read the generated report and inspect every generated `MEMORY.md` and every TODO description.
- Replace generated index text with short overviews and ordinary relative Markdown links before applying.
- Keep `$MEMORY_DIR/skills/` unchanged.
- Apply only after validation passes.

## Workflow

1. Choose an absolute review directory outside `$MEMORY_DIR`. Use a new directory name so a prior review cannot be overwritten.

2. Stage the conversion without changing the source:

   ```text
   node "<SKILL_DIR>/scripts/memfs-v2.mjs" stage --source "<MEMORY_DIR>" --output "<REVIEW_DIR>"
   ```

3. Inspect the report and review directory. Fix names, TODO descriptions, overview text, and links. `MEMORY.md` has no frontmatter. Every other memory Markdown file has exactly `name` and `description` frontmatter.

4. Validate the prepared tree:

   ```text
   node "<SKILL_DIR>/scripts/memfs-v2.mjs" validate --source "<REVIEW_DIR>"
   ```

5. Apply and commit the reviewed tree:

   ```text
   node "<SKILL_DIR>/scripts/memfs-v2.mjs" apply --source "<REVIEW_DIR>" --memory-dir "<MEMORY_DIR>" --agent "<AGENT_ID>"
   ```

   Apply commits the reviewed tree, adds the tag through the local backend, and updates a recognized managed prompt to the v2 variant. Activation refuses custom prompts so v1 path instructions cannot remain active. If that happens, replace or adapt the custom prompt before staging a fresh review tree.

6. Ask the user to run `/recompile`.

Replace the angle-bracket placeholders with their absolute values before running each command. Do not delete the review directory or its adjacent manifest until activation and recompile succeed.
