---
name: "modifying-letta-code"
description: "Modify your own Letta Code harness: permission rules, hooks, and agent configuration (model, context window, name, toolset, system prompt). Use when you want to self-evolve or change your own deterministic configuration, not your memory."
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

Hooks run shell commands or LLM prompt checks in response to Letta Code events. Use them to audit actions, inject context, enforce policy, auto-format after edits, notify on completion, or block unsafe actions.

### Choose the scope first

- **User scope**: `~/.letta/settings.json` — applies everywhere. Best for personal audit logs, notifications, and global safety rails.
- **Project scope**: `./.letta/settings.json` — applies to everyone using the repo. Best for team-shared formatting or policy.
- **Local scope**: `./.letta/settings.local.json` — applies only to this checkout. Best for personal project overrides or experiments; should be gitignored.

The helper supports all three:

```bash
python3 <skill-dir>/scripts/add_hook.py ... --scope user
python3 <skill-dir>/scripts/add_hook.py ... --scope project --cwd /path/to/repo
python3 <skill-dir>/scripts/add_hook.py ... --scope local --cwd /path/to/repo
```

### Events

**Tool events** require a `matcher`:

| Event | When it runs | Blocking behavior |
|-------|--------------|-------------------|
| `PreToolUse` | Before a tool runs | Exit 2 blocks the tool |
| `PostToolUse` | After a tool succeeds | Good for logging/context; do not rely on it to undo work |
| `PostToolUseFailure` | After a tool fails | Good for diagnostics; it cannot make the failed tool succeed |
| `PermissionRequest` | When an approval dialog would show | Exit 0 allows; exit 2 denies |

**Simple events** do not use a matcher:

| Event | When it runs |
|-------|--------------|
| `UserPromptSubmit` | User submits a normal prompt, not a slash command |
| `Stop` | Agent finishes a response |
| `SubagentStop` | Subagent completes |
| `PreCompact` | Before context compaction |
| `SessionStart` | Session starts |
| `SessionEnd` | Session ends |
| `Notification` | Notification event fires |

### Matchers

Tool-event matchers are regex-style patterns over the tool name. `*` is the special match-all value.

Common matchers:

```text
Bash          # shell commands
Edit|Write    # edits and writes
Read|Grep     # reads/searches
*             # all tools
```

Prefer narrow matchers. Use `*` only for cheap logging or broad policy checks.

### Hook types

#### Command hooks

Command hooks run a shell command. The hook input JSON is written to stdin. The command also receives useful environment variables:

- `LETTA_HOOK_EVENT` — event name
- `LETTA_WORKING_DIR` / `USER_CWD` — working directory
- `LETTA_AGENT_ID` / `AGENT_ID` — present when the event has an agent id

Exit codes matter:

- `0` — allow / success
- `2` — block, for blocking-capable events
- Any other code or timeout — hook error

Example: log every Bash invocation as one JSON line:

```bash
mkdir -p ~/.letta/hooks
cat > ~/.letta/hooks/log-bash.py <<'PY'
import pathlib
import sys

path = pathlib.Path.home() / ".letta" / "bash-audit.jsonl"
path.parent.mkdir(exist_ok=True)
path.open("a").write(sys.stdin.read() + "\n")
PY

python3 <skill-dir>/scripts/add_hook.py \
  --event PreToolUse \
  --matcher Bash \
  --type command \
  --command 'python3 ~/.letta/hooks/log-bash.py' \
  --scope user
```

Example: block shell commands containing `rm -rf`:

```bash
mkdir -p ~/.letta/hooks
cat > ~/.letta/hooks/check-bash.py <<'PY'
import json
import sys

data = json.load(sys.stdin)
cmd = str(data.get("tool_input", {}).get("command", ""))
if "rm -rf" in cmd:
    print("rm -rf is blocked by hook", file=sys.stderr)
    sys.exit(2)
PY

python3 <skill-dir>/scripts/add_hook.py \
  --event PreToolUse \
  --matcher Bash \
  --type command \
  --command 'python3 ~/.letta/hooks/check-bash.py' \
  --scope user
```

For anything non-trivial, write a script somewhere stable and call it from the hook. This avoids brittle shell quoting:

```json
{
  "type": "command",
  "command": "python3 ~/.letta/hooks/check-bash.py",
  "timeout": 60000
}
```

#### Prompt hooks

Prompt hooks send the hook input to an LLM evaluator. Use `$ARGUMENTS` inside the prompt to insert the event JSON; if omitted, the JSON is appended automatically.

Supported prompt-hook events:
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SubagentStop`.

The evaluator must return JSON with `ok: true` or `ok: false`; when blocking, include `reason`.

Example: LLM gate for edits:

```bash
python3 <skill-dir>/scripts/add_hook.py \
  --event PreToolUse \
  --matcher "Edit|Write" \
  --type prompt \
  --prompt 'Allow only edits under src/ unless the user explicitly requested otherwise. Respond with JSON. Input: $ARGUMENTS' \
  --model gpt-5.2 \
  --scope project
```

### Direct edit format

Tool events group hooks under matcher entries:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.letta/hooks/check-bash.py",
            "timeout": 60000
          }
        ]
      }
    ]
  }
}
```

Simple events omit matchers:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "say done" }
        ]
      }
    ]
  }
}
```

Disable hooks in a settings file with:

```json
{
  "hooks": {
    "disabled": true
  }
}
```

### Hook input fields

All hook inputs include `event_type` and `working_directory`. Event-specific fields commonly include:

- Tool events: `tool_name`, `tool_input`, `tool_call_id`
- `PostToolUse`: `tool_result`
- `PostToolUseFailure`: `error_message`, `error_type`
- `PermissionRequest`: `permission`, `session_permissions`
- `UserPromptSubmit`: `prompt`, `conversation_id`, `agent_id`
- `Stop`: `stop_reason`, `message_count`, `tool_call_count`, `assistant_message`, `user_message`
- `SessionStart` / `SessionEnd`: session metadata, `agent_id`, `conversation_id`

When unsure, add a temporary logging hook and inspect the JSON it writes.

### Practical patterns

- **Audit tools**: `PreToolUse` + `matcher: "*"` + append stdin to JSONL.
- **Safety gate**: `PreToolUse` on `Bash` or `Edit|Write`; exit 2 with a stderr reason to block.
- **Permission policy**: `PermissionRequest`; exit 0 for known-safe requests and exit 2 for known-dangerous ones.
- **Auto-format**: `PostToolUse` on `Edit|Write`; run a fast idempotent formatter.
- **Context injection**: `UserPromptSubmit` or `SessionStart`; stdout can be fed back as context.
- **Notifications**: `Stop` or `SessionEnd`; call `say`, `terminal-notifier`, Slack scripts, etc.

### Debug hooks

Show merged config:

```bash
python3 <skill-dir>/scripts/show_config.py
```

Common gotchas:

- Settings-file changes usually require a fresh session to be picked up reliably.
- Project/local hooks depend on starting Letta Code from the intended project root.
- JSON quoting inside shell one-liners is fragile; use a separate script for real logic.
- Long-running hooks block the agent. Keep hooks fast and set `timeout`.
- Prompt hooks require an agent id and LLM access.

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
