---
name: memory-defrag
description: Defragment and clean up agent memory blocks. Use when memory becomes messy, redundant, or poorly organized. Backs up memory, uses a subagent to clean it up, then restores the cleaned version.
---

# Memory Defragmentation Skill

This skill helps you maintain clean, well-organized memory blocks by:
1. Backing up current memory to local files
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
bun .letta/memory-utils/backup-memory.ts $LETTA_AGENT_ID .letta/backups/working
```

This creates:
- `.letta/backups/<agent-id>/<timestamp>/` - Timestamped backup for rollback
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

Files to edit: persona.md, human.md, project.md
Do NOT edit: skills.md (auto-generated), loaded_skills.md (system-managed)

After editing, provide a report with before/after character counts.`
})
```

The memory subagent will:
- Read the files from `.letta/backups/working/`
- Edit them to remove redundancy and add structure
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
// Step 1: Backup
Bash({
  command: "bun .letta/memory-utils/backup-memory.ts $LETTA_AGENT_ID .letta/backups/working",
  description: "Backup memory to local files"
})

// Step 2: Clean up (subagent edits files)
Task({
  subagent_type: "memory",
  description: "Clean up memory files",
  prompt: "Edit memory files in .letta/backups/working/ to remove redundancy and add structure. Focus on persona.md, human.md, and project.md. Report changes made."
})

// Step 3: Restore
Bash({
  command: "bun .letta/memory-utils/restore-memory.ts $LETTA_AGENT_ID .letta/backups/working",
  description: "Restore cleaned memory blocks"
})
```

## Rollback

If something goes wrong, restore from the timestamped backup:

```bash
# Find the backup directory
ls -la .letta/backups/<agent-id>/

# Restore from specific timestamp
bun .letta/memory-utils/restore-memory.ts $LETTA_AGENT_ID .letta/backups/<agent-id>/<timestamp>
```

## Dry Run

Preview changes without applying them:

```bash
bun .letta/memory-utils/restore-memory.ts $LETTA_AGENT_ID .letta/backups/working --dry-run
```

## What the Memory Subagent Does

The memory subagent focuses ONLY on editing files. It:
- ✅ Reads files from `.letta/backups/working/`
- ✅ Edits files to improve structure and remove redundancy
- ✅ Provides detailed before/after reports
- ❌ Does NOT run backup scripts (main agent does this)
- ❌ Does NOT run restore scripts (main agent does this)

This separation means the subagent only needs file editing permissions (`acceptEdits` mode), not full Bash access.

## Tips

**What to clean up:**
- Duplicate information (version mentioned 3x, preferences repeated)
- Walls of text without structure
- Contradictions ("be detailed" vs "sometimes be concise")
- Speculation ("probably", "maybe")
- Transient details that won't matter in a week

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
