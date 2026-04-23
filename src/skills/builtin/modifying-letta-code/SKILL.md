---
name: "modifying-letta-code"
description: "Modify the Letta Code harness: permission rules, hooks, and agent configuration (model, context window, name, toolset). Use when you want to change deterministic agent behavior that isn't part of the agent's memory."
---

# Modifying Letta Code

This skill explains how to modify the **Letta Code harness** — the deterministic configuration layer around your agent. Harness changes are predictable and reproducible: the same configuration always produces the same behavior.

## Memory vs Harness

Understanding this distinction is critical:

| Layer | What it is | Who controls it | Where it lives |
|-------|-----------|-----------------|----------------|
| **Memory** | Dynamic, learned knowledge | The agent (autonomously reads/writes) | `$MEMORY_DIR` (memory blocks), memfs, conversation history |
| **Harness** | Deterministic configuration | The user (via settings files or slash commands) | `settings.json`, agent LLM config, hooks, permissions |

**Memory** changes as the agent learns, summarizes, and reorganizes. It's non-deterministic — the same prompt can produce different memory updates over time.

**Harness** is deterministic. It defines *how* the agent runs: which model, which tools are allowed, what happens before/after tool calls, what system prompt preset is used. The same harness config always produces the same agent behavior.

Use this skill when you want to modify the **harness**. Use the memory tool or skills for memory changes.

## Settings Files

Harness config lives in three JSON files, merged in this precedence (highest wins):

1. **Local** (`./.letta/settings.local.json`) — gitignored, personal overrides
2. **Project** (`./.letta/settings.json`) — shared with team via git
3. **User** (`~/.letta/settings.json`) — global defaults

Session-level changes (e.g., `/allow` during a session) are in-memory only and don't persist.

## What You Can Modify

This skill covers three main harness modifications:

1. [Permission rules](#1-permissions) — which tools run without approval
2. [Hooks](#2-hooks) — commands or prompts that fire on events
3. [Agent configuration](#3-agent-configuration) — model, context window, name, toolset

---

## 1. Permissions

Permission rules control which tool calls require user approval.

### Rule Format

`ToolName(argument-pattern)` — three types: `allow`, `deny`, `ask`

**Bash commands** use prefix matching with `:*`:

| Rule | Matches |
|------|---------|
| `Bash(npm install:*)` | `npm install`, `npm install lodash`, etc. |
| `Bash(git status)` | Exact match only |
| `Bash(curl:*)` | Any curl command |
| `Bash(:*)` | All bash commands |

**File operations** use glob patterns:

| Rule | Matches |
|------|---------|
| `Read(src/**)` | Any file under `src/` recursively |
| `Write(*.md)` | Markdown files in cwd |
| `Edit(**/*.ts)` | TypeScript files anywhere |
| `Read(//etc/hosts)` | Absolute path (`//` prefix) |

### Settings File Format

```json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Read(src/**)"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": []
  }
}
```

### Helper Scripts

```bash
# Add a rule
python3 <skill-dir>/scripts/add_permission.py --rule "Bash(curl:*)" --type allow --scope user

# View all rules
python3 <skill-dir>/scripts/list_permissions.py
```

---

## 2. Hooks

Hooks run commands or LLM prompts in response to events. Use them to enforce policy, log activity, auto-format, or gate actions.

### Event Types

**Tool events** (require a `matcher` to select tools):
- `PreToolUse` — before tool call, can block
- `PostToolUse` — after tool call succeeds, cannot block
- `PostToolUseFailure` — after tool call fails, feeds stderr back to agent
- `PermissionRequest` — when permission dialog appears, can allow/deny

**Simple events** (no matcher):
- `UserPromptSubmit` — user sends a prompt, can block
- `Notification` — a notification is shown
- `Stop` — agent finishes responding, can block
- `SubagentStop` — subagent task completes, can block
- `PreCompact` — before context compaction
- `SessionStart` / `SessionEnd`

### Hook Types

**Command hooks** run shell commands:
```json
{
  "type": "command",
  "command": "prettier --write $CLAUDE_FILE_PATHS",
  "timeout": 60000
}
```

**Prompt hooks** send the event JSON to an LLM for evaluation:
```json
{
  "type": "prompt",
  "prompt": "Block if $ARGUMENTS contains secrets. Respond with {\"ok\": bool, \"reason\": str}.",
  "model": "gpt-5.2",
  "timeout": 30000
}
```
Supported on: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SubagentStop`.

### Settings File Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo \"Running: $TOOL_INPUT\" >> ~/.letta/audit.log"
          }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Is this change safe? Input: $ARGUMENTS"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {"type": "command", "command": "say 'done'"}
        ]
      }
    ]
  }
}
```

Matcher patterns:
- Exact: `"Bash"`, `"Edit"`
- Multiple: `"Edit|Write|MultiEdit"`
- All: `"*"` or `""`

### Helper Script

```bash
# Add a command hook on PreToolUse for Bash
python3 <skill-dir>/scripts/add_hook.py \
  --event PreToolUse \
  --matcher Bash \
  --type command \
  --command 'echo "bash: $TOOL_INPUT" >> ~/.letta/audit.log' \
  --scope user
```

---

## 3. Agent Configuration

Agent-level config splits into two storage locations:
- **Harness-side settings** (in `settings.json`) — agents CAN modify via Write/Edit tools
- **Server-side config** (model, name, description, system prompt) — agents modify via the Letta API client, NOT via slash commands

### ⚠️ Slash commands are TUI-only

Slash commands like `/model`, `/rename`, `/system`, `/toolset`, `/memfs`, `/pin` are user-facing CLI commands — they only run in the interactive TUI and **cannot be invoked by the agent**. The agent has no slash-command execution tool.

The table below shows what each command does and how an agent can achieve the same effect programmatically.

| User command | What it changes | How the agent can do it |
|--------------|----------------|------------------------|
| `/model` | LLM model, context window, reasoning effort | Letta API client: `client.agents.modify(agent_id, llm_config=...)` |
| `/rename agent <name>` | Agent display name | Letta API client: `client.agents.modify(agent_id, name="new-name")` |
| `/description <text>` | Agent description | Letta API client: `client.agents.modify(agent_id, description="...")` |
| `/system` | System prompt preset | Letta API client: `client.agents.modify(agent_id, system="...")` + edit `settings.json` `agents[].systemPromptPreset` |
| `/toolset` | Tool preference | Edit `settings.json` `agents[].toolset` directly |
| `/memfs enable\|disable` | Memory filesystem addon | Edit `settings.json` `agents[].memfs` + update system prompt via API |
| `/pin` / `/unpin` | Quick-switch pinning | Edit `settings.json` `pinnedAgents` array directly |

### What the agent CAN modify directly

These are pure JSON edits in `settings.json` — the agent can do them with Write/Edit:

**Per-agent harness settings** (in `~/.letta/settings.json`):
```json
{
  "agents": [
    {
      "agentId": "agent-abc123",
      "baseUrl": "https://api.letta.com",
      "pinned": true,
      "memfs": { "enabled": true },
      "toolset": "full",
      "systemPromptPreset": "letta-code-v2"
    }
  ]
}
```

**Pinning**:
```json
{
  "pinnedAgents": ["agent-abc123", "agent-def456"]
}
```

### Server-side changes (require the Letta API)

Model, name, description, and system prompt live on the Letta server. To change them, the agent needs to call the Letta API client:

```python
from letta_client import Letta
client = Letta(token=os.environ["LETTA_API_KEY"])

# Change the model
client.agents.modify(
    agent_id="agent-abc123",
    llm_config={"model": "claude-sonnet-4.5", "context_window": 200000}
)

# Rename
client.agents.modify(agent_id="agent-abc123", name="new-name")

# Update description
client.agents.modify(agent_id="agent-abc123", description="refactoring helper")
```

**Load the `letta-api-client` skill** for full SDK docs, auth setup, and more patterns.

### CLI subcommands

The `letta` CLI only supports `list` and `create` for agents — no update/rename. Use the API client for modifications.

```bash
# List all agents
letta agents list

# Create a new agent
letta agents create \
  --name "my-agent" \
  --model "claude-sonnet-4.5" \
  --description "helper for refactoring" \
  --pinned
```

---

## Quick Reference: "I want to..."

Legend: **[Agent]** = agent can do this, **[User]** = TUI-only

| Goal | Agent path | User path |
|------|-----------|-----------|
| Auto-approve a bash command | `add_permission.py --rule "Bash(cmd:*)" --type allow --scope user` | `/allow` in TUI |
| Block dangerous commands | Add to `deny` list in `settings.json` | Edit settings |
| Log all tool calls | `add_hook.py --event PreToolUse --matcher "*" --type command --command ...` | Edit settings |
| Auto-format after edits | `add_hook.py --event PostToolUse --matcher "Edit\|Write" ...` | Edit settings |
| Change the model | Letta API: `client.agents.modify(agent_id, llm_config=...)` | `/model` |
| Rename the agent | Letta API: `client.agents.modify(agent_id, name=...)` | `/rename agent` |
| Change description | Letta API: `client.agents.modify(agent_id, description=...)` | `/description` |
| Change system prompt | Letta API: `client.agents.modify(agent_id, system=...)` | `/system` |
| Switch toolset | Edit `agents[].toolset` in `~/.letta/settings.json` | `/toolset` |
| Disable memfs | Edit `agents[].memfs` in `~/.letta/settings.json` + update system prompt via API | `/memfs disable` |
| Pin agent to quick-switch | Edit `pinnedAgents` in `~/.letta/settings.json` | `/pin` |
| View current harness | `python3 <skill-dir>/scripts/show_config.py` | Same |

> **Agent rule of thumb**: Harness changes (permissions, hooks, `settings.json` per-agent fields, pinning) are pure JSON edits — the agent can do them with Write/Edit. Server-side agent fields (model, name, description, system prompt) require the **Letta API client** — load the `letta-api-client` skill.

---

## Troubleshooting

### Changes not taking effect

- **Settings files**: Restart Letta Code — most settings load at startup.
- **Agent config** (`/model`, `/system`): changes apply immediately but may need a new conversation to fully reset context.
- **Hooks**: reload by restarting the session. Check the hooks event matches what you expect.

### Finding the right permission pattern

When a tool execution is prompted for approval, note the exact call shown. Use that to craft a rule:
- Prompt shows `Bash(npm run build)` → rule `Bash(npm run:*)`
- Prompt shows `Read(/Users/me/project/src/index.ts)` → rule `Read(src/**)`

### Viewing merged config

```bash
python3 <skill-dir>/scripts/show_config.py
```

Shows permissions, hooks, and per-agent settings merged across all scopes.
