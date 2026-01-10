---
name: memory-defrag
description: Defragment and clean up agent memory blocks. Use when memory becomes messy, redundant, or poorly organized. Backs up memory, uses a subagent to clean it up, then restores the cleaned version.
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

### Step 1: Download Agent File and Dump Memory to Files

```bash
# Download agent file to backups
bun .letta/memory-utils/download-agent.ts $LETTA_AGENT_ID

# Dump memory blocks to files
bun .letta/memory-utils/backup-memory.ts $LETTA_AGENT_ID .letta/backups/working
```

This creates:
- `.letta/backups/<agent-id>/<timestamp>.af` - Complete agent file backup for full rollback
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
- Remove redundant information
- Add clear structure with markdown headers
- Organize content with bullet points
- Resolve contradictions
- Improve scannability

IMPORTANT: If a file is 100% redundant (all content exists in other files), DELETE the file using Bash (rm command). Do NOT just mark it as deprecated - actually delete it.

Files to edit: persona.md, human.md, project.md
Do NOT edit: skills.md (auto-generated), loaded_skills.md (system-managed)

After editing, provide a report with before/after character counts and list any deleted files.`
})
```

The memory subagent will:
- Read the files from `.letta/backups/working/`
- Edit them to remove redundancy and add structure
- DELETE files that are completely redundant (don't just mark as deprecated)
- Provide a detailed report of changes

### Step 3: Restore Cleaned Files to Memory

```bash
bun .letta/memory-utils/restore-memory.ts $LETTA_AGENT_ID .letta/backups/working
```

This will:
- Compare each file to current memory blocks
- Update only the blocks that changed
- Show before/after character counts
- Skip unchanged blocks

## Example Complete Flow

```typescript
// Step 1: Download agent file and dump memory
Bash({
  command: "bun .letta/memory-utils/download-agent.ts $LETTA_AGENT_ID && bun .letta/memory-utils/backup-memory.ts $LETTA_AGENT_ID .letta/backups/working",
  description: "Download agent file and dump memory to files"
})

// Step 2: Clean up (subagent edits files)
Task({
  subagent_type: "memory",
  description: "Clean up memory files",
  prompt: "Edit memory files in .letta/backups/working/ to remove redundancy and add structure. Focus on persona.md, human.md, and project.md. DELETE any files that are 100% redundant (use rm command). Report changes made."
})

// Step 3: Restore
Bash({
  command: "bun .letta/memory-utils/restore-memory.ts $LETTA_AGENT_ID .letta/backups/working",
  description: "Restore cleaned memory blocks"
})
```

## Rollback

If something goes wrong, you have two rollback options:

### Option 1: Restore Memory Blocks Only

```bash
# Find the backup directory
ls -la .letta/backups/<agent-id>/

# Restore from specific timestamp
bun .letta/memory-utils/restore-memory.ts $LETTA_AGENT_ID .letta/backups/<agent-id>/<timestamp>
```

### Option 2: Full Agent Restore (Nuclear Option)

If memory restoration isn't enough, restore the entire agent from the .af backup:

```bash
# Find the agent backup
ls -la .letta/backups/<agent-id>/*.af

# The .af file can be used to recreate the agent entirely
# Use: letta --from-af .letta/backups/<agent-id>/<timestamp>.af
```

## Dry Run

Preview changes without applying them:

```bash
bun .letta/memory-utils/restore-memory.ts $LETTA_AGENT_ID .letta/backups/working --dry-run
```

## What the Memory Subagent Does

The memory subagent focuses on cleaning up files. It:
- ✅ Reads files from `.letta/backups/working/`
- ✅ Edits files to improve structure and remove redundancy
- ✅ Deletes completely redundant files (using `rm` command)
- ✅ Provides detailed before/after reports
- ❌ Does NOT run backup scripts (main agent does this)
- ❌ Does NOT run restore scripts (main agent does this)

The subagent needs Bash access to delete redundant files, but does not need to manage the backup/restore workflow.

## Tips

**What to clean up:**
- Duplicate information (version mentioned 3x, preferences repeated)
- Walls of text without structure
- Contradictions ("be detailed" vs "sometimes be concise")
- Speculation ("probably", "maybe")
- Transient details that won't matter in a week

**When to DELETE a file:**
- File is 100% redundant - all content already exists in other organized files
- File is just a "deprecated" notice pointing to other files
- Don't just mark it deprecated - actually delete it with `rm`

**What to preserve:**
- User preferences (sacred - don't delete)
- Project conventions discovered through experience
- Important context for future sessions
- Learnings from past mistakes

**Good memory structure:**
- Use markdown headers (##, ###)
- Organize with bullet points
- Keep related information together
- Make it scannable at a glance
