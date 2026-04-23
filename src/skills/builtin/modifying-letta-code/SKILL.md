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

Agent-level config (model, name, toolset, etc.) is modified through slash commands or CLI subcommands, not by editing settings.json directly. Most changes persist to the Letta server via the agent API.

### Slash Commands

| Command | What it changes | Where it persists |
|---------|----------------|-------------------|
| `/model` | LLM model + context window + reasoning effort | Agent LLM config (server) |
| `/rename agent <name>` | Agent display name | Agent record (server) |
| `/description <text>` | Agent description | Agent record (server) |
| `/system` | System prompt preset | Agent + `settings.json` `agents[].systemPromptPreset` |
| `/toolset` | Which tools are enabled | `settings.json` `agents[].toolset` |
| `/memfs enable\|disable\|sync\|reset` | Memory filesystem addon | Agent system prompt + `settings.json` `agents[].memfs` |
| `/pin` / `/unpin` | Pin agent to quick-switch list | `settings.json` `pinnedAgents` |

### CLI Subcommands

```bash
# List all agents
letta agents list

# Create a new agent
letta agents create \
  --name "my-agent" \
  --model "claude-sonnet-4.5" \
  --description "helper for refactoring" \
  --tags "work,coding" \
  --pinned
```

### Per-Agent Settings

When the harness stores per-agent preferences (toolset, memfs, preset), it does so in `~/.letta/settings.json` under the `agents` array:

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

These settings complement (don't replace) the agent's server-side config.

### Server-Side Config

Model, context window, and system prompt are stored on the Letta server. Modify them with `/model`, `/system`, etc. — these call the agent update API. If you want to change them programmatically, use the Letta API client directly (see `letta-api-client` skill if available).

---

## Quick Reference: "I want to..."

| Goal | Do |
|------|-----|
| Auto-approve a bash command | `add_permission.py --rule "Bash(cmd:*)" --type allow --scope user` |
| Block dangerous commands | Add to `deny` list in settings.json |
| Log all tool calls | Add `PreToolUse` command hook with `*` matcher |
| Auto-format after edits | Add `PostToolUse` command hook matching `Edit|Write` |
| Change the model | `/model` |
| Rename the agent | `/rename agent <name>` |
| Switch toolset | `/toolset` |
| Disable memfs | `/memfs disable` |
| Pin agent to quick-switch | `/pin` |
| View current harness | `python3 <skill-dir>/scripts/show_config.py` |

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
