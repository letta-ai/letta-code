---
name: defragmenting-memory
description: Defragments and cleans up agent memory blocks. Use when memory becomes messy, redundant, or poorly organized. Backs up memory, uses a subagent to clean it up, then restores the cleaned version.
---

# Memory Defragmentation Skill

This skill helps you maintain clean, well-organized memory blocks by:
1. Dumping current memory to local files and backing up the agent file
2. Using the memory subagent to clean up the files
3. Restoring the cleaned files back to memory

## When to Use

- Memory blocks have redundant information
- Memory lacks structure (walls of text)
- Memory contains contradictions
- Memory has grown stale or outdated
- After major project milestones
- Every 50-100 conversation turns

## Workflow

### Step 1: Backup Memory to Files

```bash
npx tsx <SKILL_DIR>/scripts/backup-memory.ts $LETTA_AGENT_ID .letta/backups/working
```

This creates:
- `.letta/backups/<agent-id>/<timestamp>/` - Timestamped memory blocks backup
- `.letta/backups/working/` - Working directory with editable files
- Each memory block as a `.md` file: `persona.md`, `human.md`, `project.md`, etc.

### Step 2: Spawn Memory Subagent to Clean Files

```typescript
Task({
  subagent_type: "memory",
  description: "Clean up memory files",
  prompt: `Edit the memory block files in .letta/backups/working/ to clean them up.

Focus on:
- Reorganize and consolidate redundant information
- Add clear structure with markdown headers
- Organize content with bullet points
- Resolve contradictions
- Improve scannability

IMPORTANT: When merging blocks, DELETE the redundant source files after consolidating their content (use Bash rm command). You have full bash access in the .letta/backups/working directory. Only delete files when: (1) you've merged their content into another block, or (2) the file contains only irrelevant/junk data with no project value.

Files to edit: persona.md, human.md, project.md
Do NOT edit: skills.md (auto-generated), loaded_skills.md (system-managed)

After editing, provide a report with before/after character counts and list any deleted files.`
})
```

The memory subagent will:
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
// Step 1: Backup memory to files
Bash({
  command: "npx tsx <SKILL_DIR>/scripts/backup-memory.ts $LETTA_AGENT_ID .letta/backups/working",
  description: "Backup memory to files"
})

// Step 2: Clean up (subagent edits files and deletes merged ones)
Task({
  subagent_type: "memory",
  description: "Clean up memory files",
  prompt: "Edit memory files in .letta/backups/working/ to reorganize and consolidate redundancy. Focus on persona.md, human.md, and project.md. Merge related blocks together and DELETE the source files after merging (use Bash rm command - you have full bash access). Add clear structure. Report what was merged and where, and which files were deleted."
})

// Step 3: Restore
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

## What the Memory Subagent Does

The memory subagent focuses on cleaning up files. It:
- Reads files from `.letta/backups/working/`
- Edits files to improve structure and consolidate redundancy
- Merges related blocks together to reduce fragmentation
- Reorganizes information for better clarity and scannability
- Deletes source files after merging their content (using Bash `rm` command)
- Provides detailed before/after reports including merge operations
- Does NOT run backup scripts (main agent does this)
- Does NOT run restore scripts (main agent does this)

The memory subagent runs with `bypassPermissions` mode, giving it full Bash access to delete files after merging them. The focus is on consolidation and reorganization.

## Tips

**What to clean up:**
- Duplicate information (consolidate into one well-organized section)
- Walls of text without structure (add headers and bullets)
- Contradictions (resolve by clarifying or choosing the better guidance)
- Speculation ("probably", "maybe" - make it concrete or remove)
- Transient details that won't matter in a week

**Reorganization Strategy:**
- Consolidate duplicate information into a single, well-structured section
- Merge related content that's scattered across multiple blocks
- Add clear headers and bullet points for scannability
- Group similar information together logically
- After merging blocks, DELETE the source files to avoid duplication

**When to DELETE a file:**
- After merging - You've consolidated its content into another block (common and encouraged)
- Junk data - File contains only irrelevant test/junk data with no project connection
- Empty/deprecated - File is just a notice with no unique information
- Don't delete - If file has unique information that hasn't been merged elsewhere

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
