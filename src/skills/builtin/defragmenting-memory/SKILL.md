---
name: defragmenting-memory
description: Decomposes and reorganizes agent memory blocks into focused, single-purpose components. Use when memory has large multi-topic blocks, redundancy, or poor organization. Backs up memory, uses a subagent to decompose and clean it up, then restores the improved version.
---

# Memory Defragmentation Skill

This skill helps you maintain clean, well-organized memory blocks by:
1. Dumping current memory to local files and backing up the agent file
2. Using a subagent to decompose and reorganize the files
3. Restoring the cleaned files back to memory

The focus is on **decomposition**—splitting large, multi-purpose blocks into focused, single-purpose components—rather than consolidation.

## When to Use

- Memory blocks have redundant information
- Memory lacks structure (walls of text)
- Memory contains contradictions
- Memory has grown stale or outdated
- After major project milestones
- Every 50-100 conversation turns

## Workflow

⚠️ **CRITICAL SAFETY REQUIREMENT**: You MUST complete Step 1 (backup) before proceeding to Step 2. The backup is your safety net. Do not spawn the subagent until the backup is guaranteed to have succeeded.

### Step 1: Backup Memory to Files

```bash
npx tsx <SKILL_DIR>/scripts/backup-memory.ts $LETTA_AGENT_ID .letta/backups/working
```

This creates:
- `.letta/backups/<agent-id>/<timestamp>/` - Timestamped memory blocks backup
- `.letta/backups/working/` - Working directory with editable files
- Each memory block as a `.md` file: `persona.md`, `human.md`, `project.md`, etc.

### Step 2: Spawn Subagent to Clean Files

```typescript
Task({
  subagent_type: "memory",
  description: "Clean up and decompose memory files",
  prompt: `⚠️ CRITICAL PREREQUISITE: The agent memory blocks MUST be backed up to .letta/backups/working/ BEFORE you begin this task. The main agent must have run backup-memory.ts first. You are ONLY responsible for editing the files in that working directory—the backup is your safety net.

You are decomposing and reorganizing memory block files in .letta/backups/working/ to improve clarity and focus. "Decompose" means take large memory blocks with multiple sections and split them into smaller memory blocks, each with fewer sections and a single focused purpose.

## Evaluation Criteria

1. **DECOMPOSITION** - Split large, multi-purpose blocks into focused, single-purpose components
   - Example: A "persona" block mixing Git operations, communication style, AND behavioral preferences should become separate blocks like "communication-style.md", "behavioral-preferences.md", "version-control-practices.md"
   - Example: A "project" block with structure, patterns, rendering, error handling, and architecture should split into specialized blocks like "architecture.md", "patterns.md", "rendering-approach.md", "error-handling.md"
   - Goal: Each block should have ONE clear purpose that can be described in a short title
   - Create new files when splitting (e.g., communication-style.md, behavioral-preferences.md)

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
   - Create new .md files for each focused purpose
   - Use clear, descriptive filenames (e.g., "keyboard-protocols.md", "error-handling-patterns.md")
   - Ensure each new block has ONE primary purpose

3. **Clean Up** - For remaining blocks (or new focused blocks):
   - Add markdown structure with headers and bullets
   - Remove redundancy
   - Resolve contradictions
   - Improve clarity

4. **Delete** - Remove files only when appropriate
   - After consolidating into other blocks (rare - most blocks should stay focused)
   - Never delete a focused, single-purpose block
   - Only delete if a block contains junk/irrelevant data with no value

## Files to Edit
- persona.md → Consider splitting into: communication-style.md, behavioral-preferences.md, technical-practices.md
- project.md → Consider splitting into: architecture.md, patterns.md, rendering.md, error-handling.md, etc.
- human.md → OK to keep as-is if focused on understanding the user
- DO NOT edit: skills.md (auto-generated), loaded_skills.md (system-managed)

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
- Read the files from `.letta/backups/working/`
- Edit them to reorganize and consolidate redundancy
- Merge related blocks together for better organization
- Add clear structure with markdown formatting
- Delete source files after merging their content into other blocks
- Provide a detailed report of changes (including what was merged where)

### Step 3: Restore Cleaned Files to Memory

```bash
npx tsx <SKILL_DIR>/scripts/restore-memory.ts $LETTA_AGENT_ID .letta/backups/working
```

This will:
- Compare each file to current memory blocks
- Update only the blocks that changed
- Show before/after character counts
- Skip unchanged blocks

## Example Complete Flow

```typescript
// ⚠️ STEP 1 IS MANDATORY: Backup memory to files
// This MUST complete successfully before proceeding to Step 2
Bash({
  command: "npx tsx <SKILL_DIR>/scripts/backup-memory.ts $LETTA_AGENT_ID .letta/backups/working",
  description: "Backup memory to files (MANDATORY prerequisite)"
})

// ⚠️ STEP 2 CAN ONLY BEGIN AFTER STEP 1 SUCCEEDS
// The subagent works on the backed-up files, with the original memory safe
Task({
  subagent_type: "memory",
  description: "Clean up and decompose memory files",
  prompt: "Decompose and reorganize memory block files in .letta/backups/working/. Be aggressive about splitting large multi-section blocks into many smaller, single-purpose blocks with fewer sections. Prefer creating new focused files over keeping large blocks. Structure with markdown headers and bullets. Remove redundancy and speculation. Resolve contradictions. Organize logically. Each block should have ONE clear purpose. Create new files for decomposed blocks rather than consolidating. Report files created, modified, deleted, before/after character counts, and rationale for changes."
})

// Step 3: Restore (only after cleanup is approved)
// Review the subagent's report before running this
Bash({
  command: "npx tsx <SKILL_DIR>/scripts/restore-memory.ts $LETTA_AGENT_ID .letta/backups/working",
  description: "Restore cleaned memory blocks"
})
```

## Rollback

If something goes wrong, restore from a previous backup:

```bash
# Find the backup directory
ls -la .letta/backups/<agent-id>/

# Restore from specific timestamp
npx tsx <SKILL_DIR>/scripts/restore-memory.ts $LETTA_AGENT_ID .letta/backups/<agent-id>/<timestamp>
```

## Dry Run

Preview changes without applying them:

```bash
npx tsx <SKILL_DIR>/scripts/restore-memory.ts $LETTA_AGENT_ID .letta/backups/working --dry-run
```

## What the Subagent Does

The subagent focuses on decomposing and cleaning up files. It has full tool access (including Bash) and:
- Discovers `.md` files in `.letta/backups/working/` (via Glob or Bash)
- Reads and examines each file's content
- Identifies multi-purpose blocks that serve 2+ distinct purposes
- Splits large blocks into focused, single-purpose components
- Modifies/creates .md files for decomposed blocks
- Improves structure with headers and bullet points
- Removes redundancy and speculation across blocks
- Resolves contradictions with clear, concrete guidance
- Organizes content logically (general to specific, by importance)
- Provides detailed before/after reports including decomposition rationale
- Does NOT run backup scripts (main agent does this)
- Does NOT run restore scripts (main agent does this)

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
- Create new specialized blocks with clear, single-purpose titles
- Example: A "persona" mixing communication style + Git practices → split into "communication-style.md" and "version-control-practices.md"
- Example: A "project" with structure + patterns + rendering → split into "architecture.md", "patterns.md", "rendering.md"
- Add clear headers and bullet points for scannability
- Group similar information together within focused blocks

**When to DELETE a file:**
- Only delete if file contains junk/irrelevant data with no project value
- Don't delete after decomposing - Each new focused block is valuable
- Don't delete unique information just to reduce file count
- Exception: Delete source files only if consolidating multiple blocks into one (rare)

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
