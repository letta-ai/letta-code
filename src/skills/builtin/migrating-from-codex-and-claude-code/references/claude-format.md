# Claude Code Data Format Reference

## Directory Structure

```
~/.claude/
├── history.jsonl              # Global prompt history
├── projects/                  # Per-project data
│   └── -Users-...-<path>/     # Encoded directory paths
│       ├── sessions-index.json    # Quick session metadata
│       ├── <session-uuid>.jsonl   # Full conversation sessions
│       └── agent-<id>.jsonl       # Agent-specific sessions
├── settings.json              # User preferences
├── statsig/                   # Analytics
└── debug/                     # Debug logs
```

## Path Encoding

Claude encodes project paths by replacing `/` with `-`:
```
/Users/username/repos/myproject → -Users-username-repos-myproject
```

To encode a path programmatically:
```bash
ENCODED=$(pwd | sed 's|/|-|g')
```

## Global History (`history.jsonl`)

Each line is a JSON object representing a user prompt:

```json
{
  "display": "fix this test: npm run test:unit",
  "pastedContents": {},
  "timestamp": 1759105062139,
  "project": "/Users/username/repos/myproject",
  "sessionId": "0fd6a5d1-c1e4-494f-82d6-9391ccc1797d"
}
```

| Field | Description |
|-------|-------------|
| `display` | The user's prompt text |
| `pastedContents` | Any pasted content (files, images) |
| `timestamp` | Unix timestamp in milliseconds |
| `project` | Working directory path |
| `sessionId` | Links to session file |

## Sessions Index (`sessions-index.json`)

Quick metadata lookup without parsing full session files:

```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "0fd6a5d1-c1e4-494f-82d6-9391ccc1797d",
      "fullPath": "/Users/username/.claude/projects/-Users-sarah-repos-myproject/0fd6a5d1-....jsonl",
      "fileMtime": 1768524387632,
      "firstPrompt": "fix the failing test in auth.ts",
      "messageCount": 14,
      "created": "2026-01-16T00:39:26.583Z",
      "modified": "2026-01-16T00:46:27.609Z",
      "gitBranch": "feature/auth-fix",
      "projectPath": "/Users/username/repos/myproject",
      "isSidechain": false
    }
  ]
}
```

## Session Files (`<session-uuid>.jsonl`)

Each line is a JSON object. Message types:

### User Message

```json
{
  "type": "user",
  "uuid": "8705b595-71fb-4a97-be0b-edc2fe934724",
  "parentUuid": null,
  "sessionId": "079c7831-6083-4b29-9fe2-534da46f2585",
  "cwd": "/Users/username/repos/myproject",
  "gitBranch": "main",
  "timestamp": "2025-12-23T03:01:20.501Z",
  "message": {
    "role": "user",
    "content": "please help me fix the lint errors"
  }
}
```

### User Message with Tool Results

When responding to tool calls, content is an array:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01FTU3GpL9GpoJXd8WitDSd2",
        "content": "Exit code 0\nChecked 265 files...",
        "is_error": false
      }
    ]
  }
}
```

### Assistant Message

Content is always an array with multiple block types:

```json
{
  "type": "assistant",
  "uuid": "64064220-5503-44f1-8f3c-d6862b249309",
  "parentUuid": "8705b595-71fb-4a97-be0b-edc2fe934724",
  "message": {
    "role": "assistant",
    "model": "claude-opus-4-5-20251101",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user wants me to fix linting errors. Let me first run the lint command.",
        "signature": "EowCCkY..."
      },
      {
        "type": "text",
        "text": "I'll run the linter to see what errors exist:"
      },
      {
        "type": "tool_use",
        "id": "toolu_01FTU3GpL9GpoJXd8WitDSd2",
        "name": "Bash",
        "input": {
          "command": "bun run lint",
          "description": "Run linter"
        }
      }
    ],
    "usage": {
      "input_tokens": 10,
      "cache_creation_input_tokens": 4691,
      "cache_read_input_tokens": 14987,
      "output_tokens": 3
    }
  }
}
```

### Content Block Types

| Type | Fields | Description |
|------|--------|-------------|
| `thinking` | `thinking`, `signature` | Chain-of-thought reasoning |
| `text` | `text` | Final response text |
| `tool_use` | `id`, `name`, `input` | Tool invocation |

### Summary Entry

Auto-generated conversation summaries:

```json
{
  "type": "summary",
  "summary": "Fixed bun lint formatting issue in TypeScript file",
  "leafUuid": "25a01498-6c60-463b-b127-4e383daa97a5"
}
```

### File History Snapshot

Tracks file state at message time:

```json
{
  "type": "file-history-snapshot",
  "messageId": "8705b595-71fb-4a97-be0b-edc2fe934724",
  "snapshot": {
    "trackedFileBackups": {},
    "timestamp": "2025-12-23T03:01:20.507Z"
  }
}
```

## Common Queries

### Extract all user prompts from a session
```bash
cat session.jsonl | jq 'select(.type == "user" and (.message.content | type == "string")) | .message.content'
```

### Extract all tool calls
```bash
cat session.jsonl | jq 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | {name, input}'
```

### Get conversation flow (user → assistant pairs)
```bash
cat session.jsonl | jq -c 'select(.type == "user" or .type == "assistant") | {type, content: (.message.content | if type == "string" then . else .[0] end)}'
```

### Find sessions by tool usage
```bash
for f in ~/.claude/projects/*/*.jsonl; do
  if cat "$f" | jq -e 'select(.type == "assistant") | .message.content[]? | select(.name == "Bash")' > /dev/null 2>&1; then
    echo "$f"
  fi
done
```
