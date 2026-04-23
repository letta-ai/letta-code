---
name: "modifying-letta-code"
description: "Modify your own Letta Code harness: permission rules, hooks, and agent configuration (model, context window, name, toolset, system prompt). Use when you want to change your own deterministic configuration, not your memory."
---

# Modifying Letta Code (Self-Configuration)

This skill tells you — the agent — how to modify your own **harness**: the deterministic configuration layer around you. Load this skill when you want to change how you run (model, permissions, hooks, toolset, system prompt, name, etc.).

## Memory vs Harness

Before you change anything, know which layer you're in:

| Layer | What it is | How you change it |
|-------|-----------|-------------------|
| **Memory** | Dynamic state you learn and reorganize (`$MEMORY_DIR`, memfs, conversation history) | Memory tool, file edits in `$MEMORY_DIR`, skill operations |
| **Harness** | Deterministic config (model, permissions, hooks, toolset, system prompt) | This skill — edit `settings.json` or call the Letta API |

Memory is probabilistic: your notes evolve, your history compacts, your skills get loaded and unloaded. The harness is deterministic: given the same settings, you behave the same way. Don't conflate them — edit memory when you're learning, edit the harness when you're reconfiguring.

## Where to make changes

You have two places to modify harness config:

### 1. Settings JSON files (you can edit these directly with Write/Edit)

| File | Scope | Contents |
|------|-------|----------|
| `~/.letta/settings.json` | User (global) | Permissions, hooks, per-agent settings (`agents[]`), pinning, env vars |
| `./.letta/settings.json` | Project | Permissions, hooks, shared with team via git |
| `./.letta/settings.local.json` | Local | Permissions, hooks, personal overrides (gitignored) |

Precedence (highest wins): **local > project > user**.

### 2. The Letta API (for server-side agent state)

Your **name**, **description**, **model**, **context window**, and **system prompt** live on the Letta server. To change them, call the Letta API.

**Base URL:** `https://api.letta.com`
**Docs:** https://docs.letta.com/api-overview/introduction
**Auth:** `Authorization: Bearer $LETTA_API_KEY`

Your own agent ID is `$LETTA_AGENT_ID` (always available in your environment).

You can use the Python or TypeScript SDK, or just `curl`:

```bash
# Rename yourself
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name"}'
```

If you need rich SDK examples, load the `letta-api-client` skill.

---

## 1. Changing your permissions

Permissions control which tool calls need user approval. Edit `settings.json` directly, or use the helper script.

### Rule syntax

- **Bash** (prefix match with `:*`): `Bash(npm install:*)`, `Bash(git:*)`, `Bash(curl:*)`
- **Files** (glob): `Read(src/**)`, `Edit(**/*.ts)`, `Write(*.md)`
- **All** (dangerous): `*`, `Bash`, `Read`

### Helper: add a rule

```bash
python3 <skill-dir>/scripts/add_permission.py \
  --rule "Bash(curl:*)" \
  --type allow \
  --scope user
```

### Direct edit (in `settings.json`)

```json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Read(src/**)"],
    "deny":  ["Bash(rm -rf:*)"],
    "ask":   []
  }
}
```

After editing, your new rules apply on your next restart. In-session additions via the approval UI go into session-only memory and are cleared on exit.

---

## 2. Adding hooks

Hooks let you run a shell command or LLM prompt in response to events. Use them to log activity, enforce policy, auto-format, or gate actions.

### Events

**Tool events** (need a `matcher`):
- `PreToolUse` — before a tool runs (can block)
- `PostToolUse` — after a tool succeeds
- `PostToolUseFailure` — after a tool fails (stderr fed back to you)
- `PermissionRequest` — when a permission dialog shows (can allow/deny)

**Simple events** (no matcher):
- `UserPromptSubmit` — user sends a prompt (can block)
- `Stop` — you finish responding (can block)
- `SubagentStop` — a subagent finishes
- `PreCompact` — before context compaction
- `SessionStart`, `SessionEnd`, `Notification`

### Hook types

**Command** — runs a shell command:
```json
{"type": "command", "command": "echo $TOOL_INPUT >> ~/audit.log", "timeout": 60000}
```

**Prompt** — sends event JSON to an LLM for evaluation:
```json
{"type": "prompt", "prompt": "Is this safe? Input: $ARGUMENTS", "model": "gpt-5.2"}
```
Supported events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SubagentStop`.

### Helper: add a hook

```bash
python3 <skill-dir>/scripts/add_hook.py \
  --event PreToolUse \
  --matcher Bash \
  --type command \
  --command 'echo "bash: $TOOL_INPUT" >> ~/.letta/audit.log' \
  --scope user
```

### Direct edit (in `settings.json`)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": "echo $TOOL_INPUT >> audit.log"}]
      }
    ],
    "Stop": [
      {"hooks": [{"type": "command", "command": "say done"}]}
    ]
  }
}
```

Matchers: exact (`"Bash"`), multiple (`"Edit|Write"`), all (`"*"`).

---

## 3. Changing your agent configuration

Agent config splits between the Letta server and local settings.

### Server-side fields (use the Letta API)

Use `PATCH /v1/agents/{agent_id}` with `$LETTA_AGENT_ID`.

**Change your model and context window:**
```bash
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "llm_config": {
      "model": "claude-sonnet-4.5",
      "model_endpoint_type": "anthropic",
      "context_window": 200000
    }
  }'
```

**Rename yourself:**
```bash
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "draft-v2"}'
```

**Update your description:**
```bash
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"description": "..."}'
```

**Update your system prompt (use with care — system prompt is structural):**
```bash
curl -X PATCH "https://api.letta.com/v1/agents/$LETTA_AGENT_ID" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"system": "You are..."}'
```

For Python / TypeScript SDK usage, see `docs.letta.com/api-overview/introduction` or load the `letta-api-client` skill.

### Local per-agent harness (edit `~/.letta/settings.json`)

The `agents[]` array stores per-agent harness preferences you can edit directly:

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

- **`toolset`** — which tool set to load for this agent
- **`memfs.enabled`** — whether the memory filesystem is active
- **`systemPromptPreset`** — which preset was last applied (informational; the actual system prompt is server-side)
- **`pinned`** — show in the quick-switch list

Find your own entry by matching `agentId === $LETTA_AGENT_ID`, then edit the fields you need.

---

## Quick reference: what you want to change

| Change | What to do |
|--------|-----------|
| Auto-approve `curl` commands | `add_permission.py --rule "Bash(curl:*)" --type allow --scope user` |
| Block all `rm -rf` | Add `"Bash(rm -rf:*)"` to `permissions.deny` in `settings.json` |
| Log every Bash command | `add_hook.py --event PreToolUse --matcher Bash --type command --command '...' --scope user` |
| Auto-format after edits | `add_hook.py --event PostToolUse --matcher "Edit\|Write" --type command --command 'prettier ...' --scope project` |
| Gate edits with an LLM check | `add_hook.py --event PreToolUse --matcher Edit --type prompt --prompt '...' --scope user` |
| Change your model | `PATCH /v1/agents/$LETTA_AGENT_ID` with `llm_config.model` |
| Change your context window | `PATCH /v1/agents/$LETTA_AGENT_ID` with `llm_config.context_window` |
| Rename yourself | `PATCH /v1/agents/$LETTA_AGENT_ID` with `name` |
| Update your description | `PATCH /v1/agents/$LETTA_AGENT_ID` with `description` |
| Modify your system prompt | `PATCH /v1/agents/$LETTA_AGENT_ID` with `system` |
| Pin yourself for quick-switch | Add `agentId` to `pinnedAgents` in `~/.letta/settings.json` |
| Change toolset | Edit `agents[].toolset` in `~/.letta/settings.json` |
| Disable memfs | Edit `agents[].memfs.enabled = false` in `~/.letta/settings.json` (and update system prompt via API if needed) |
| See what's currently set | `python3 <skill-dir>/scripts/show_config.py` |

---

## After making changes

- **`settings.json` changes** — take effect on next session restart. Your current session keeps the old values.
- **Letta API changes** — apply immediately at the server level, but the in-memory agent config held by your current session may not reflect them until next restart.
- **System prompt / model changes** — always start a fresh conversation after to get a clean context with the new config.

## Helper scripts in this skill

| Script | Purpose |
|--------|---------|
| `scripts/add_permission.py` | Add an allow/deny/ask rule to any scope |
| `scripts/add_hook.py` | Add a command or prompt hook to any event |
| `scripts/show_config.py` | Show merged permissions, hooks, and per-agent settings across all scopes |

All three accept `--scope user|project|local`. Run `--help` for full usage.
