---
name: defragmenting-memory
description: Decomposes and reorganizes agent memory blocks into focused, single-purpose components. Use when memory has large multi-topic blocks, redundancy, or poor organization.
---

# Memory Defragmentation Skill

> **Requires Memory Filesystem (memfs)**
>
> This skill works by directly editing memory files on disk. It requires the memory filesystem feature to be enabled.
>
> **To check:** Look for a `memory_filesystem` block in your system prompt. If it shows a tree structure starting with `/memory/` including a `system/` directory, memfs is enabled.
>
> **To enable:** Ask the user to run `/memfs enable`, then reload the CLI.

This skill helps you maintain clean, well-organized memory blocks by:
1. Creating a safety backup of the memfs directory
2. Using a subagent to decompose and reorganize the memory files in-place

The focus is on **decomposition**—splitting large, multi-purpose blocks into focused, single-purpose components—rather than consolidation.

Memory files live at `~/.letta/agents/$LETTA_AGENT_ID/memory/` and are synced to API blocks automatically by **memfs sync** on CLI startup. There is no separate backup/restore step needed.

## When to Use

- Memory blocks have redundant information
- Memory lacks structure (walls of text)
- Memory contains contradictions
- Memory has grown stale or outdated
- After major project milestones
- Every 50-100 conversation turns

## Workflow

### Step 1: Safety Backup

Before the subagent edits files, create a timestamped backup of the memfs directory:

```bash
letta memfs backup --agent $LETTA_AGENT_ID
```

⚠️ **CRITICAL**: You MUST complete the backup before proceeding to Step 2. The backup is your safety net.

### Step 2: Spawn Subagent to Edit Memory Files

The memory subagent works directly on the memfs `system/` directory. After it finishes, memfs sync will propagate changes to the API on next CLI startup.

```typescript
Task({
  subagent_type: "memory",
  description: "Decompose and reorganize memory files",
  prompt: `You are decomposing and reorganizing memory files in ~/.letta/agents/${LETTA_AGENT_ID}/memory/system/ to improve clarity and focus.

These files ARE the agent's memory — they sync directly to API memory blocks via memfs. Changes you make here will be picked up automatically.

## Directory Structure

~/.letta/agents/<agent-id>/memory/
├── system/       ← Attached blocks (always loaded in system prompt) — EDIT THESE
├── notes.md      ← Detached blocks at root level (on-demand) — can create here
├── archive/      ← Detached blocks can be nested too
└── .sync-state.json  ← DO NOT EDIT (internal sync tracking)

## Files to Skip (DO NOT edit)
- memory_filesystem.md (auto-generated tree view)
- skills.md (auto-generated)
- loaded_skills.md (system-managed)
- .sync-state.json (internal)

## What to Edit
- persona.md → Consider splitting into: persona/identity.md, persona/values.md, persona/approach.md
- project.md → Consider splitting into: project/overview.md, project/architecture.md, project/conventions.md, etc.
- human.md → Consider splitting into: human/identity.md, human/preferences.md, etc.
- Any other non-system blocks present

## How Memfs File ↔ Block Mapping Works
- File path relative to memory root becomes the block label (system/ prefix for attached, root level for detached)
- Example: system/project/tooling/bun.md → block label "project/tooling/bun"
- New files you create will become new memory blocks on next sync
- Files you delete will cause the corresponding blocks to be deleted on next sync
- YAML frontmatter is supported for metadata (label, description, limit, read_only)

## Evaluation Criteria

1. **DECOMPOSITION** - Split large, multi-purpose blocks into focused, single-purpose components
   - Example: A "persona" block mixing identity, values, AND approach should become persona/identity.md, persona/values.md, persona/approach.md
   - Example: A "project" block with overview, architecture, conventions, and gotchas should split into project/overview.md, project/architecture.md, project/conventions.md, project/gotchas.md
   - Goal: Each block should have ONE clear purpose described by its filename
   - Use hierarchical / naming (e.g., project/tooling/bun.md, not project-tooling-bun.md)

2. **STRUCTURE** - Organize content with clear markdown formatting
   - Use headers (##, ###) for subsections
   - Use bullet points for lists
   - Make content scannable at a glance

3. **CONCISENESS** - Remove redundancy and unnecessary detail
   - Eliminate duplicate information across blocks
   - Remove speculation ("probably", "maybe", "I think")
   - Keep only what adds unique value

4. **CLARITY** - Resolve contradictions and improve readability
   - If blocks contradict, clarify or choose the better guidance
   - Use plain language, avoid jargon
   - Ensure each statement is concrete and actionable

5. **ORGANIZATION** - Group related information logically
   - Within each block, organize content from general to specific
   - Order sections by importance

## Workflow

1. **Analyze** - Read each file and identify its purpose(s)
   - If a block serves 2+ distinct purposes, it needs decomposition
   - Flag blocks where subtopics could be their own focused blocks

2. **Decompose** - Split multi-purpose blocks into specialized files
   - Create new files using hierarchical paths (e.g., project/tooling/bun.md)
   - Ensure each new block has ONE primary purpose

3. **Clean Up** - For remaining blocks (or new focused blocks):
   - Add markdown structure with headers and bullets
   - Remove redundancy
   - Resolve contradictions
   - Improve clarity

4. **Delete** - Remove files only when appropriate
   - After moving all content to new decomposed files
   - Never delete a focused, single-purpose block
   - Only delete if a block contains junk/irrelevant data with no value

## Success Indicators
- No block tries to cover 2+ distinct topics
- Each block title clearly describes its single purpose
- Content within each block is focused and relevant to its title
- Well-organized with markdown structure
- Clear reduction in confusion/overlap across blocks

Provide a detailed report including:
- Files created (new decomposed blocks)
- Files modified (what changed)
- Files deleted (if any, explain why)
- Before/after character counts
- Rationale for how decomposition improves the memory structure`
})
```

The subagent will:
- Read files from `~/.letta/agents/<agent-id>/memory/system/` (and root level for detached)
- Edit them to reorganize and decompose large blocks
- Create new hierarchically-named files (e.g., `project/overview.md`)
- Add clear structure with markdown formatting
- Delete source files after decomposing their content into focused children
- Provide a detailed report of changes

After the subagent finishes, **memfs sync will automatically propagate changes** to API blocks on the next CLI startup. No manual restore step is needed.

## Example Complete Flow

```typescript
// Step 1: Safety backup (MANDATORY)
Bash({
  command: "letta memfs backup --agent $LETTA_AGENT_ID",
  description: "Backup memfs directory before defrag"
})

// Step 2: Spawn subagent to decompose and reorganize
Task({
  subagent_type: "memory",
  description: "Decompose and reorganize memory files",
  prompt: "Decompose and reorganize memory files in ~/.letta/agents/$LETTA_AGENT_ID/memory/system/. These files sync directly to API blocks via memfs. Be aggressive about splitting large multi-section blocks into many smaller, single-purpose blocks using hierarchical / naming. Skip memory_filesystem.md, skills.md, loaded_skills.md, and .sync-state.json. Structure with markdown headers and bullets. Remove redundancy and speculation. Resolve contradictions. Organize logically. Each block should have ONE clear purpose. Report files created, modified, deleted, before/after character counts, and rationale for changes."
})

// No Step 3 needed — memfs sync handles propagation to API blocks
```

## Rollback

If something goes wrong, restore from the safety backup:

```bash
# Find backups
letta memfs backups --agent $LETTA_AGENT_ID

# Restore from a specific backup (replace the current memory dir)
letta memfs restore --agent $LETTA_AGENT_ID --from memory-backup-<TIMESTAMP> --force
```

On next CLI startup, memfs sync will detect the changes and update API blocks accordingly.

## What the Subagent Does

The subagent focuses on decomposing and cleaning up files. It has full tool access (including Bash) and:
- Discovers `.md` files in `~/.letta/agents/<agent-id>/memory/system/` (via Glob or Bash)
- Reads and examines each file's content
- Identifies multi-purpose blocks that serve 2+ distinct purposes
- Splits large blocks into focused, single-purpose components with hierarchical naming
- Modifies/creates .md files for decomposed blocks
- Improves structure with headers and bullet points
- Removes redundancy and speculation across blocks
- Resolves contradictions with clear, concrete guidance
- Organizes content logically (general to specific, by importance)
- Provides detailed before/after reports including decomposition rationale
- Does NOT run any backup or restore scripts

The focus is on decomposition—breaking apart large monolithic blocks into focused, specialized components rather than consolidating them together.

## Tips

**What to clean up:**
- Duplicate information (consolidate into one well-organized section)
- Walls of text without structure (add headers and bullets)
- Contradictions (resolve by clarifying or choosing the better guidance)
- Speculation ("probably", "maybe" - make it concrete or remove)
- Transient details that won't matter in a week

**Decomposition Strategy:**
- Split blocks that serve 2+ distinct purposes into focused components
- Use hierarchical `/` naming: `project/tooling/bun.md`, not `project-bun.md`
- Create parent index files that reference children
- Example: A "persona" mixing identity + values + approach → split into `persona/identity.md`, `persona/values.md`, `persona/approach.md`
- Example: A "project" with overview + architecture + conventions → split into `project/overview.md`, `project/architecture.md`, `project/conventions.md`
- Add clear headers and bullet points for scannability
- Group similar information together within focused blocks

**When to DELETE a file:**
- Only delete if file contains junk/irrelevant data with no project value
- Delete source files after fully decomposing content into child files
- Don't delete unique information just to reduce file count

**What to preserve:**
- User preferences (sacred - never delete)
- Project conventions discovered through experience
- Important context for future sessions
- Learnings from past mistakes
- Any information that has unique value

**Good memory structure:**
- Use markdown headers (##, ###)
- Organize with bullet points
- Keep related information together
- Make it scannable at a glance
- Use `/` hierarchy for discoverability
