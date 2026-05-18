# Hook configuration reference

Use this reference when adding, debugging, or explaining Letta Code hooks.

## Contents

- [Before adding a hook](#before-adding-a-hook)
- [Scopes and merge order](#scopes-and-merge-order)
- [Events](#events)
- [Matchers](#matchers)
- [Command hooks](#command-hooks)
- [Prompt hooks](#prompt-hooks)
- [Direct JSON format](#direct-json-format)
- [Hook input fields](#hook-input-fields)
- [Practical patterns](#practical-patterns)
- [Debugging](#debugging)

## Before adding a hook

Inspect existing config first:

```bash
python3 <skill-dir>/scripts/show_config.py
```

Avoid duplicate hooks, contradictory safety policies, and broad hooks when a narrow matcher is enough.

## Scopes and merge order

| Scope | File | Use for |
|-------|------|---------|
| User | `~/.letta/settings.json` | Personal global hooks: audit logs, notifications, global safety rails |
| Project | `./.letta/settings.json` | Team-shared hooks committed with the repo |
| Local | `./.letta/settings.local.json` | Personal project overrides or experiments; should be gitignored |

Hooks from all scopes are merged. Execution order is:

1. Project-local hooks
2. Project hooks
3. User hooks

Project or local scope only works as intended when Letta Code is running from the project root.

## Events

Tool events require a `matcher`:

| Event | When it runs | Blocking behavior |
|-------|--------------|-------------------|
| `PreToolUse` | Before a tool runs | Exit 2 blocks the tool |
| `PostToolUse` | After a tool succeeds | Good for logging/context; do not rely on it to undo work |
| `PostToolUseFailure` | After a tool fails | Good for diagnostics; it cannot make the failed tool succeed |
| `PermissionRequest` | When an approval dialog would show | Exit 0 allows; exit 2 denies |

Simple events do not use a matcher:

| Event | When it runs |
|-------|--------------|
| `UserPromptSubmit` | User submits a normal prompt, not a slash command |
| `Stop` | Agent finishes a response |
| `SubagentStop` | Subagent completes |
| `PreCompact` | Before context compaction |
| `SessionStart` | Session starts |
| `SessionEnd` | Session ends |
| `Notification` | Notification event fires |

## Matchers

Tool-event matchers are case-sensitive regex patterns over the tool name. `*` is the special match-all value.

Common matchers:

```text
Bash          # shell commands
Edit|Write    # edits and writes
Read|Grep     # reads/searches
*             # all tools
```

Prefer narrow matchers. Use `*` only for cheap logging or broad policy checks.

## Command hooks

Command hooks run a shell command. The hook input JSON is written to stdin. The command also receives:

- `LETTA_HOOK_EVENT` — event name
- `LETTA_WORKING_DIR` / `USER_CWD` — working directory
- `LETTA_AGENT_ID` / `AGENT_ID` — present when the event has an agent id

Exit codes:

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

## Prompt hooks

Prompt hooks send the hook input to an LLM evaluator. Use `$ARGUMENTS` inside the prompt to insert the event JSON; if omitted, the JSON is appended automatically.

Supported prompt-hook events:
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SubagentStop`.

The evaluator must return JSON with `ok: true` or `ok: false`; when blocking, include `reason`.

Example:

```bash
python3 <skill-dir>/scripts/add_hook.py \
  --event PreToolUse \
  --matcher "Edit|Write" \
  --type prompt \
  --prompt 'Allow only edits under src/ unless the user explicitly requested otherwise. Input: $ARGUMENTS' \
  --scope project
```

Add `--model <model-name>` only when a specific model is required.

## Direct JSON format

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

A user-level `"disabled": false` explicitly keeps hooks enabled and overrides project/local `disabled: true`. Without that user-level override, project or local `disabled: true` disables hooks.

## Hook input fields

All hook inputs include `event_type` and `working_directory`. Event-specific fields commonly include:

- Tool events: `tool_name`, `tool_input`, `tool_call_id`
- `PostToolUse`: `tool_result`
- `PostToolUseFailure`: `error_message`, `error_type`
- `PermissionRequest`: `permission`, `session_permissions`
- `UserPromptSubmit`: `prompt`, `conversation_id`, `agent_id`
- `Stop`: `stop_reason`, `message_count`, `tool_call_count`, `assistant_message`, `user_message`
- `SessionStart` / `SessionEnd`: session metadata, `agent_id`, `conversation_id`

When unsure, add a temporary logging hook and inspect the JSON it writes.

## Practical patterns

- **Audit tools**: `PreToolUse` + `matcher: "*"` + append stdin to JSONL.
- **Safety gate**: `PreToolUse` on `Bash` or `Edit|Write`; exit 2 with a stderr reason to block.
- **Permission policy**: `PermissionRequest`; exit 0 for known-safe requests and exit 2 for known-dangerous ones.
- **Auto-format**: `PostToolUse` on `Edit|Write`; run a fast idempotent formatter.
- **Context injection**: `UserPromptSubmit` or `SessionStart`; stdout can be fed back as context.
- **Notifications**: `Stop` or `SessionEnd`; call `say`, `terminal-notifier`, Slack scripts, etc.

## Debugging

Show merged config:

```bash
python3 <skill-dir>/scripts/show_config.py
```

Common gotchas:

- External edits to hook settings through scripts or direct JSON may require a fresh session because hooks are read through the settings manager cache.
- In-app hook management APIs update the in-memory settings immediately.
- Project/local hooks depend on starting Letta Code from the intended project root.
- JSON quoting inside shell one-liners is fragile; use a separate script for real logic.
- Long-running hooks block the agent. Keep hooks fast and set `timeout`.
- Prompt hooks require an agent id and LLM access.
