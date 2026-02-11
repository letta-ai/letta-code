# OpenAI Codex Data Format Reference

## Directory Structure

```
~/.codex/
├── history.jsonl              # Global prompt history
├── sessions/                  # Per-session data, organized by date
│   └── <year>/
│       └── <month>/
│           └── <day>/
│               └── rollout-<timestamp>.jsonl  # Session files
├── config.toml                # User configuration
└── instructions.md            # Custom instructions file
```

## Global History (`history.jsonl`)

Each line is a JSON object representing a user prompt:

```json
{
  "text": "fix the failing test in auth.ts",
  "ts": 1759105062
}
```

| Field | Description |
|-------|-------------|
| `text` | The user's prompt text |
| `ts` | Unix timestamp in seconds |

Note: Unlike Claude Code, Codex history doesn't include the project path. You need to correlate with session files to determine project context.

## Configuration (`config.toml`)

```toml
model = "o4-mini"

[history]
persistence = "across-sessions"
save_inputs = true

[[project_doc_approval]]
project_directory = "/Users/username/repos/myproject"

[[full_auto_approval]]
project_directory = "/Users/username/repos/myproject"
```

Key fields:
- `model` - Default model
- `project_doc_approval` - Projects where docs auto-approval is enabled
- `full_auto_approval` - Projects with full auto-approval (trusted)

## Session Files (`rollout-<timestamp>.jsonl`)

Each line is a JSON object. Event types:

### Session Metadata

First entry in each session file:

```json
{
  "type": "session_meta",
  "payload": {
    "model_provider": "openai",
    "model_name": "o4-mini",
    "cwd": "/Users/username/repos/myproject",
    "session_id": "sess_abc123",
    "git": {
      "branch": "main",
      "commit": "abc1234"
    }
  },
  "ts": 1759105062
}
```

### User Message

```json
{
  "type": "event_msg",
  "payload": {
    "type": "user_message",
    "message": "fix the failing test in auth.ts"
  },
  "ts": 1759105063
}
```

### Agent Reasoning

```json
{
  "type": "event_msg",
  "payload": {
    "type": "agent_reasoning",
    "text": "I need to look at the test file to understand what's failing..."
  },
  "ts": 1759105064
}
```

### Function Call (Tool Use)

```json
{
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "id": "fc_abc123",
    "call_id": "call_abc123",
    "name": "shell",
    "arguments": "{\"command\":[\"cat\",\"src/tests/auth.test.ts\"]}"
  },
  "ts": 1759105065
}
```

Common function names:
- `shell` - Execute shell commands
- `file_edit` - Edit files
- `file_read` - Read files
- `create_file` - Create new files

### Function Call Output

```json
{
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "call_id": "call_abc123",
    "output": "import { test, expect } from 'bun:test';\n..."
  },
  "ts": 1759105066
}
```

### Assistant Message

```json
{
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "output_text",
        "text": "I found the issue. The test is failing because..."
      }
    ]
  },
  "ts": 1759105067
}
```

### Background Event (Exec Approval)

```json
{
  "type": "event_msg",
  "payload": {
    "type": "exec_approval_request",
    "command": ["npm", "run", "test"]
  },
  "ts": 1759105068
}
```

## Key Differences from Claude Code

| Feature | Claude Code | Codex |
|---------|-------------|-------|
| **History format** | Includes project path | No project path |
| **Session organization** | By project directory | By date |
| **Path encoding** | Replace `/` with `-` | N/A |
| **Tool call format** | `tool_use` blocks | `function_call` events |
| **Thinking** | `thinking` blocks | `agent_reasoning` events |
| **Timestamps** | Milliseconds | Seconds |
| **Session index** | `sessions-index.json` | None (scan date dirs) |
| **Config format** | JSON | TOML |

## Useful jq Queries

```bash
# List all sessions with their project directories
find ~/.codex/sessions -name "*.jsonl" -exec sh -c 'echo "$1: $(head -1 "$1" | jq -r ".payload.cwd // \"?\"" 2>/dev/null)"' _ {} \;

# Get all user messages from a session
cat rollout-*.jsonl | jq -r 'select(.type == "event_msg" and .payload.type == "user_message") | .payload.message'

# Get all tool calls from a session
cat rollout-*.jsonl | jq 'select(.type == "response_item" and .payload.type == "function_call") | {name: .payload.name, args: .payload.arguments}'

# Find sessions that used shell commands
cat rollout-*.jsonl | jq -r 'select(.type == "response_item" and .payload.type == "function_call" and .payload.name == "shell") | .payload.arguments | fromjson | .command | join(" ")'

# Get assistant text responses
cat rollout-*.jsonl | jq -r 'select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant") | .payload.content[]? | select(.type == "output_text") | .text'

# Search history by keyword
cat ~/.codex/history.jsonl | jq -r --arg kw "test" 'select(.text | test($kw; "i")) | "\(.ts | strftime("%Y-%m-%d %H:%M"))  \(.text)"'

# Find all trusted projects
grep -A1 "full_auto_approval" ~/.codex/config.toml 2>/dev/null
```

## Session File Naming

Session files follow the pattern:
```
rollout-<ISO-timestamp>.jsonl
```

Example: `rollout-2025-12-23T03:01:20.501Z.jsonl`

Sessions are organized by date:
```
sessions/
└── 2025/
    └── 12/
        └── 23/
            └── rollout-2025-12-23T03:01:20.501Z.jsonl
```
