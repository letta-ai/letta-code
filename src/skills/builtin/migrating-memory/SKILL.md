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
   letta memory export --agent <source-agent-id> --out /tmp/letta-memory-<source-agent-id>
   ```

2. **Copy the files you want into your own memfs**
   - `system/` = attached blocks (always loaded)
   - root = detached blocks

   Example:
   ```bash
   cp -r /tmp/letta-memory-agent-abc123/system/project ~/.letta/agents/$LETTA_AGENT_ID/memory/system/
   cp /tmp/letta-memory-agent-abc123/notes.md ~/.letta/agents/$LETTA_AGENT_ID/memory/
   ```

3. **Commit and push the memory repo**
   ```bash
   cd ~/.letta/agents/$LETTA_AGENT_ID/memory
   git add system/project notes.md
   git commit -m "Import memory from source agent"
   git push
   ```

This gives you full control over what you bring across and keeps everything consistent with memfs.

## If MemFS Is Disabled

The legacy block-level CLI commands have been removed. Enable MemFS first, then use the export → copy → sync workflow above.

If you run into duplicate filenames while copying memory files, rename the incoming file or merge its contents manually before committing.

## Workflow

### Step 1: Identify Source Agent

Ask the user for the source agent's ID (e.g., `agent-abc123`).

If they don't know the ID, invoke the **finding-agents** skill to search:
```
Skill({ skill: "finding-agents" })
```

Example: "What's the ID of the agent you want to migrate memory from?"

## Example: Migrating Project Memory

Scenario: You're a new agent and want to inherit memory from an existing agent "ProjectX-v1".

1. **Get source agent ID from user:**
   User provides: `agent-abc123`

2. **Export their memfs:**
   ```bash
   letta memory export --agent agent-abc123 --out /tmp/letta-memory-agent-abc123
   ```

3. **Copy the relevant files into your memfs:**
   ```bash
   cp -r /tmp/letta-memory-agent-abc123/system/project ~/.letta/agents/$LETTA_AGENT_ID/memory/system/
   ```

4. **Commit and push:**
   ```bash
   cd ~/.letta/agents/$LETTA_AGENT_ID/memory
   git add system/project
   git commit -m "Import project memory"
   git push
   ```
