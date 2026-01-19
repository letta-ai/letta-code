# OpenAI Codex Data Format Reference

## Directory Structure

```
~/.codex/
├── history.jsonl              # Global prompt history
├── sessions/                  # Session data by date
│   └── <year>/<month>/<day>/
│       └── rollout-<timestamp>-<session-id>.jsonl
├── config.toml                # User configuration
├── auth.json                  # Authentication
├── skills/                    # User-defined skills
└── log/                       # Debug logs
```

## Global History (`history.jsonl`)

Each line is a JSON object representing a user prompt:

```json
{
  "session_id": "019b109f-bc18-7291-9cbf-10cbe0c51250",
  "ts": 1765510477,
  "text": "help me find places in our code where we might have idle transactions"
}
```

| Field | Description |
|-------|-------------|
| `session_id` | Links to session file |
| `ts` | Unix timestamp in seconds |
| `text` | The user's prompt text |

## Session Files (`rollout-<timestamp>-<session-id>.jsonl`)

Each line is a JSON object with `timestamp`, `type`, and `payload`:

### Record Types

| Type | Payload Types | Description |
|------|--------------|-------------|
| `session_meta` | - | Session metadata |
| `response_item` | `message`, `function_call`, `function_call_output`, `reasoning`, `ghost_snapshot` | Conversation items |
| `event_msg` | `user_message`, `agent_reasoning`, `agent_message`, `token_count` | Events |
| `turn_context` | - | Per-turn metadata |

### Session Meta

First entry in each session file:

```json
{
  "timestamp": "2025-12-12T03:34:22.511Z",
  "type": "session_meta",
  "payload": {
    "id": "019b109f-bc18-7291-9cbf-10cbe0c51250",
    "timestamp": "2025-12-12T03:34:22.488Z",
    "cwd": "/Users/username/repos/myproject",
    "originator": "codex_cli_rs",
    "cli_version": "0.71.0",
    "instructions": null,
    "source": "cli",
    "model_provider": "openai",
    "git": {
      "commit_hash": "68039c606f8c5010a57068005025740b77155782",
      "branch": "main",
      "repository_url": "git@github.com:org/repo.git"
    }
  }
}
```

### User Message

```json
{
  "timestamp": "2025-12-12T03:34:37.406Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "user",
    "content": [
      {
        "type": "input_text",
        "text": "help me find the bug in auth.ts"
      }
    ]
  }
}
```

### User Message Event

Raw user input (often duplicates response_item):

```json
{
  "timestamp": "2025-12-12T03:34:37.406Z",
  "type": "event_msg",
  "payload": {
    "type": "user_message",
    "message": "help me find the bug in auth.ts",
    "images": []
  }
}
```

### Assistant Message

```json
{
  "timestamp": "2025-12-12T03:34:45.073Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "output_text",
        "text": "I'll search for potential issues in the auth module."
      }
    ]
  }
}
```

### Agent Reasoning

Thinking/planning text:

```json
{
  "timestamp": "2025-12-12T03:34:45.004Z",
  "type": "event_msg",
  "payload": {
    "type": "agent_reasoning",
    "text": "**Searching for transaction patterns**\n\nI need to find patterns where..."
  }
}
```

### Reasoning Summary

Structured thinking with summary:

```json
{
  "timestamp": "2025-12-12T03:34:45.005Z",
  "type": "response_item",
  "payload": {
    "type": "reasoning",
    "summary": [
      {
        "type": "summary_text",
        "text": "**Searching for transaction patterns**\n\nI need to find..."
      }
    ],
    "content": null,
    "encrypted_content": "gAAAAABpO41U..."
  }
}
```

### Function Call (Tool Use)

```json
{
  "timestamp": "2025-12-12T03:34:46.462Z",
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "shell_command",
    "arguments": "{\"command\":\"rg -n \\\"blocks_agents\\\" .\",\"workdir\":\"/Users/username/repos/myproject\"}",
    "call_id": "call_z83FuakeMWWlIpMhf2YpkLVA"
  }
}
```

### Function Call Output (Tool Result)

```json
{
  "timestamp": "2025-12-12T03:34:49.538Z",
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "call_id": "call_z83FuakeMWWlIpMhf2YpkLVA",
    "output": "Exit code: 0\nWall time: 0 seconds\nOutput:\n./src/orm/blocks_agents.py:10:..."
  }
}
```

### Turn Context

Metadata about each conversation turn:

```json
{
  "timestamp": "2025-12-12T03:34:49.539Z",
  "type": "turn_context",
  "payload": {
    "cwd": "/Users/username/repos/myproject",
    "approval_policy": "on-request",
    "sandbox_policy": {
      "type": "workspace-write",
      "network_access": false
    },
    "model": "gpt-5.2",
    "effort": "medium",
    "summary": "auto"
  }
}
```

### Token Count

Usage statistics:

```json
{
  "timestamp": "2025-12-12T03:34:49.130Z",
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {
        "input_tokens": 8414,
        "cached_input_tokens": 1152,
        "output_tokens": 688,
        "reasoning_output_tokens": 231,
        "total_tokens": 9102
      },
      "model_context_window": 258400
    }
  }
}
```

## Configuration (`config.toml`)

```toml
model = "gpt-5.2-codex"
model_reasoning_effort = "medium"

[projects."/Users/username/repos/myproject"]
trust_level = "trusted"

[history]
persistence = "save-all"
```

## Common Queries

### Extract all user messages from a session
```bash
cat rollout-*.jsonl | jq 'select(.type == "event_msg" and .payload.type == "user_message") | .payload.message'
```

### Extract all function calls
```bash
cat rollout-*.jsonl | jq 'select(.type == "response_item" and .payload.type == "function_call") | {name: .payload.name, args: .payload.arguments}'
```

### Get session metadata
```bash
cat rollout-*.jsonl | jq 'select(.type == "session_meta") | .payload'
```

### Count tool usage by name
```bash
cat rollout-*.jsonl | jq 'select(.type == "response_item" and .payload.type == "function_call") | .payload.name' | sort | uniq -c | sort -rn
```

### Find sessions by working directory
```bash
for f in ~/.codex/sessions/*/*/*/*rollout*.jsonl; do
  cwd=$(cat "$f" | jq -r 'select(.type == "session_meta") | .payload.cwd' 2>/dev/null)
  if [[ "$cwd" == "/Users/username/repos/myproject"* ]]; then
    echo "$f"
  fi
done
```

### Extract reasoning/thinking
```bash
cat rollout-*.jsonl | jq 'select(.type == "event_msg" and .payload.type == "agent_reasoning") | .payload.text'
```
