---
name: migrating-memory
description: Migrate memory blocks from an existing agent to the current agent. Use when the user wants to copy or share memory from another agent, or during /init when setting up a new agent that should inherit memory from an existing one.
---

# Migrating Memory

This skill helps migrate memory blocks from an existing agent to a new agent, similar to macOS Migration Assistant for AI agents.

> **Requires Memory Filesystem (memfs)**
>
> This workflow is memfs-first. If memfs is enabled, do **not** use the legacy block commands — they can conflict with file-based edits.
>
> **To check:** Look for a `memory_filesystem` block in your system prompt. If it shows a tree structure starting with `/memory/` including a `system/` directory, memfs is enabled.
>
> **To enable:** Ask the user to run `/memfs enable`, then reload the CLI.

## When to Use This Skill

- User is setting up a new agent that should inherit memory from an existing one
- User wants to share memory blocks across multiple agents
- User is replacing an old agent with a new one
- User mentions they have an existing agent with useful memory

## Migration Method (memfs-first)

### Export → Copy → Sync

This is the recommended flow:

1. **Export the source agent's memfs to a temp directory**
   ```bash
   letta memfs export --agent <source-agent-id> --out /tmp/letta-memfs-<source-agent-id>
   ```

2. **Copy the files you want into your own memfs**
   - `system/` = attached blocks (always loaded)
   - root = detached blocks

   Example:
   ```bash
   cp -r /tmp/letta-memfs-agent-abc123/system/project ~/.letta/agents/$LETTA_AGENT_ID/memory/system/
   cp /tmp/letta-memfs-agent-abc123/notes.md ~/.letta/agents/$LETTA_AGENT_ID/memory/
   ```

3. **Sync to API**
   ```bash
   letta memfs sync --agent $LETTA_AGENT_ID
   ```

This gives you full control over what you bring across and keeps everything consistent with memfs.

## Legacy Fallback (only if memfs is disabled)

If memfs is **not enabled**, you can use block-level commands:
- `letta blocks list`
- `letta blocks copy`
- `letta blocks attach`

⚠️ **Do not use these if memfs is enabled** — they can diverge from file-based edits.

## Handling Duplicate Label Errors

**You cannot have two blocks with the same label.** If you try to copy/attach a block and you already have one with that label, you'll get a `duplicate key value violates unique constraint` error.

**Solutions:**

1. **Use `--label` (copy only):** Rename the block when copying:
   ```bash
   letta blocks copy --block-id <id> --label project-imported
   ```

2. **Use `--override` (copy or attach):** Automatically detach your existing block first:
   ```bash
   letta blocks copy --block-id <id> --override
   letta blocks attach --block-id <id> --override
   ```
   If the operation fails, the original block is automatically reattached.

3. **Manual detach first:** Use the `memory` tool to detach your existing block:
   ```
   memory(agent_state, "delete", path="/memories/<label>")
   ```
   Then run the copy/attach script.

**Note:** `letta blocks attach` does NOT support `--label` because attached blocks keep their original label (they're shared, not copied).

## Workflow

### Step 1: Identify Source Agent

Ask the user for the source agent's ID (e.g., `agent-abc123`).

If they don't know the ID, load the **finding-agents** skill to search:
```
Skill({ command: "load", skills: ["finding-agents"] })
```

Example: "What's the ID of the agent you want to migrate memory from?"

## Example: Migrating Project Memory

Scenario: You're a new agent and want to inherit memory from an existing agent "ProjectX-v1".

1. **Get source agent ID from user:**
   User provides: `agent-abc123`

2. **Export their memfs:**
   ```bash
   letta memfs export --agent agent-abc123 --out /tmp/letta-memfs-agent-abc123
   ```

3. **Copy the relevant files into your memfs:**
   ```bash
   cp -r /tmp/letta-memfs-agent-abc123/system/project ~/.letta/agents/$LETTA_AGENT_ID/memory/system/
   ```

4. **Sync:**
   ```bash
   letta memfs sync --agent $LETTA_AGENT_ID
   ```
