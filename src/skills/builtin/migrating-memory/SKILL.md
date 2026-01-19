---
name: migrating-memory
description: Migrate memory blocks from an existing agent to the current agent. Use when the user wants to copy or share memory from another agent, or during /init when setting up a new agent that should inherit memory from an existing one.
---

# Migrating Memory

This skill helps migrate memory blocks from an existing agent to a new agent, similar to macOS Migration Assistant for AI agents.

## When to Use This Skill

- User is setting up a new agent that should inherit memory from an existing one
- User wants to share memory blocks across multiple agents
- User is replacing an old agent with a new one
- User mentions they have an existing agent with useful memory

## Migration Methods

### 1. Manual Copy (Recommended for partial content)

If you only need **part** of a source block, or the source is messy and needs cleanup:
1. Use `get-agent-blocks.ts` to view the source block's content
2. Use the `memory` tool to create a new block with just the content you want
3. No scripts needed - you have full control over what gets copied

Best for: Extracting sections, cleaning up messy content, selective migration.

### 2. Script Copy (Full block duplication)

Creates new blocks with the same content using `copy-block.ts`. After copying:
- You own the copy - changes don't sync
- Best for: One-time migration, forking an agent

### 3. Share (Linked Blocks)

Attaches the same block to multiple agents using `attach-block.ts`. After sharing:
- All agents see the same block content
- Changes by any agent are visible to all others
- Can be read-only (target can read but not modify)
- Best for: Shared knowledge bases, synchronized state

## Handling Duplicate Label Errors

**You cannot have two blocks with the same label.** If you try to copy/attach a block and you already have one with that label, you'll get a `duplicate key value violates unique constraint` error.

**Solutions:**

1. **Use `--label` (copy only):** Rename the block when copying:
   ```bash
   npx tsx <SKILL_DIR>/scripts/copy-block.ts --block-id <id> --label project-imported
   ```

2. **Use `--override` (copy or attach):** Automatically detach your existing block first:
   ```bash
   npx tsx <SKILL_DIR>/scripts/copy-block.ts --block-id <id> --override
   npx tsx <SKILL_DIR>/scripts/attach-block.ts --block-id <id> --override
   ```
   If the operation fails, the original block is automatically reattached.

3. **Manual detach first:** Use the `memory` tool to detach your existing block:
   ```
   memory(agent_state, "delete", path="/memories/<label>")
   ```
   Then run the copy/attach script.

**Note:** `attach-block.ts` does NOT support `--label` because attached blocks keep their original label (they're shared, not copied).

## Workflow

### Step 1: Identify Source Agent

Ask the user for the source agent's ID (e.g., `agent-abc123`).

If they don't know the ID, load the **finding-agents** skill to search:
```
Skill({ command: "load", skills: ["finding-agents"] })
```

Example: "What's the ID of the agent you want to migrate memory from?"

### Step 2: View Source Agent's Blocks

Inspect what memory blocks the source agent has:

```bash
npx tsx <SKILL_DIR>/scripts/get-agent-blocks.ts --agent-id <source-agent-id>
```

This shows each block's ID, label, description, and value.

### Step 3: Migrate Blocks

For each block you want to migrate, choose copy or share:

**To Copy (create independent block):**
```bash
npx tsx <SKILL_DIR>/scripts/copy-block.ts --block-id <block-id> [--label <new-label>]
```

Use `--label` if you already have a block with that label (e.g., `--label project-imported`).

**To Share (attach existing block):**
```bash
npx tsx <SKILL_DIR>/scripts/attach-block.ts --block-id <block-id>
```

Add `--read-only` flag to share to make this agent unable to modify the block.

Note: These scripts automatically target the current agent (you) for safety.

## Script Reference

All scripts are located in the `scripts/` directory and output raw API responses (JSON).

| Script | Purpose | Args |
|--------|---------|------|
| `get-agent-blocks.ts` | Get blocks from an agent | `--agent-id` |
| `copy-block.ts` | Copy block to current agent | `--block-id`, optional `--label`, `--override` |
| `attach-block.ts` | Attach existing block to current agent | `--block-id`, optional `--read-only`, `--override` |

## Authentication

The bundled scripts automatically use the same authentication as Letta Code:
- Keychain/secrets storage
- `~/.config/letta/settings.json` fallback
- `LETTA_API_KEY` environment variable

You can also make direct API calls using the Letta SDK if you have the API key available.

## Example: Migrating Project Memory

Scenario: You're a new agent and want to inherit memory from an existing agent "ProjectX-v1".

1. **Get source agent ID from user:**
   User provides: `agent-abc123`

2. **List its blocks:**
   ```bash
   npx tsx <SKILL_DIR>/scripts/get-agent-blocks.ts --agent-id agent-abc123
   # Shows: project (block-def456), human (block-ghi789), persona (block-jkl012)
   ```

3. **Copy project knowledge to yourself:**
   ```bash
   # If you don't have a 'project' block yet:
   npx tsx <SKILL_DIR>/scripts/copy-block.ts --block-id block-def456
   
   # If you already have 'project', use --label to rename:
   npx tsx <SKILL_DIR>/scripts/copy-block.ts --block-id block-def456 --label project-v1
   ```

4. **Optionally share human preferences (read-only):**
   ```bash
   npx tsx <SKILL_DIR>/scripts/attach-block.ts --block-id block-ghi789 --read-only
   ```
