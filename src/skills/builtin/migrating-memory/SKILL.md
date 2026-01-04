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

### 1. Copy (Independent Blocks)

Creates new blocks with the same content. After copying:
- The new agent owns its copy
- Changes to one agent's block don't affect the other
- Best for: One-time migration, forking an agent

### 2. Share (Linked Blocks)

Attaches the same block to multiple agents. After sharing:
- All agents see the same block content
- Changes by any agent are visible to all others
- Can be read-only (target can read but not modify)
- Best for: Shared knowledge bases, synchronized state

## Workflow

### Step 1: List Available Agents

Find the source agent you want to migrate from:

```bash
npx ts-node scripts/list-agents.ts
```

This outputs all agents you have access to with their IDs and names.

### Step 2: View Source Agent's Blocks

Inspect what memory blocks the source agent has:

```bash
npx ts-node scripts/get-agent-blocks.ts --agent-id <source-agent-id>
```

This shows each block's ID, label, description, and value.

### Step 3: Migrate Blocks

For each block you want to migrate, choose copy or share:

**To Copy (create independent block):**
```bash
npx ts-node scripts/copy-block.ts --block-id <block-id>
```

**To Share (attach existing block):**
```bash
npx ts-node scripts/attach-block.ts --block-id <block-id>
```

Add `--read-only` flag to share to make this agent unable to modify the block.

Note: These scripts automatically target the current agent (you) for safety.

## Script Reference

All scripts are located in the `scripts/` directory and output raw API responses (JSON).

| Script | Purpose | Required Args |
|--------|---------|---------------|
| `list-agents.ts` | List all accessible agents | (none) |
| `get-agent-blocks.ts` | Get blocks from an agent | `--agent-id` |
| `copy-block.ts` | Copy block to current agent | `--block-id` |
| `attach-block.ts` | Attach existing block to current agent | `--block-id`, optional `--read-only` |

## Authentication

The bundled scripts automatically use the same authentication as Letta Code:
- Keychain/secrets storage
- `~/.config/letta/settings.json` fallback
- `LETTA_API_KEY` environment variable

You can also make direct API calls using the Letta SDK if you have the API key available.

## Example: Migrating Project Memory

Scenario: You're a new agent and want to inherit memory from an existing agent "ProjectX-v1".

1. **Find source agent:**
   ```bash
   npx ts-node scripts/list-agents.ts
   # Find "ProjectX-v1" ID: agent-abc123
   ```

2. **List its blocks:**
   ```bash
   npx ts-node scripts/get-agent-blocks.ts --agent-id agent-abc123
   # Shows: project (block-def456), human (block-ghi789), persona (block-jkl012)
   ```

3. **Copy project knowledge to yourself:**
   ```bash
   npx ts-node scripts/copy-block.ts --block-id block-def456
   ```

4. **Optionally share human preferences (read-only):**
   ```bash
   npx ts-node scripts/attach-block.ts --block-id block-ghi789 --read-only
   ```
