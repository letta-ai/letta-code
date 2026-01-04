---
name: agent-finder
description: Find other agents on the same server. Use when the user asks about other agents, wants to migrate memory from another agent, or needs to find an agent by name or tags.
---

# Agent Finder

This skill helps you find other agents on the same Letta server.

## When to Use This Skill

- User asks about other agents they have
- User wants to find a specific agent by name
- User wants to list agents with certain tags
- You need to find an agent ID for memory migration

## Script Usage

```bash
npx ts-node scripts/find-agents.ts [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--name <name>` | Exact name match |
| `--query <text>` | Fuzzy search by name |
| `--tags <tag1,tag2>` | Filter by tags (comma-separated) |
| `--match-all-tags` | Require ALL tags (default: ANY) |
| `--include-blocks` | Include agent.blocks in response |
| `--limit <n>` | Max results (default: 20) |

## Common Patterns

### Finding Letta Code Agents

Agents created by Letta Code are tagged with `origin:letta-code`. To find only Letta Code agents:

```bash
npx ts-node scripts/find-agents.ts --tags "origin:letta-code"
```

This is useful when the user is looking for agents they've worked with in Letta Code CLI sessions.

### Finding All Agents

If the user has agents created outside Letta Code (via ADE, SDK, etc.), search without the tag filter:

```bash
npx ts-node scripts/find-agents.ts
```

## Examples

**List all agents (up to 20):**
```bash
npx ts-node scripts/find-agents.ts
```

**Find agent by exact name:**
```bash
npx ts-node scripts/find-agents.ts --name "ProjectX-v1"
```

**Search agents by name (fuzzy):**
```bash
npx ts-node scripts/find-agents.ts --query "project"
```

**Find only Letta Code agents:**
```bash
npx ts-node scripts/find-agents.ts --tags "origin:letta-code"
```

**Find agents with multiple tags:**
```bash
npx ts-node scripts/find-agents.ts --tags "frontend,production" --match-all-tags
```

**Include memory blocks in results:**
```bash
npx ts-node scripts/find-agents.ts --query "project" --include-blocks
```

## Output

Returns the raw API response with full agent details. Key fields:
- `id` - Agent ID (e.g., `agent-abc123`)
- `name` - Agent name
- `description` - Agent description
- `tags` - Agent tags
- `blocks` - Memory blocks (if `--include-blocks` used)

## Related Skills

- **migrating-memory** - Once you find an agent, use this skill to copy/share memory blocks
