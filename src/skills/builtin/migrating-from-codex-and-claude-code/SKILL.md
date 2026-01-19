---
name: Migrating from Codex and Claude Code
description: Find and search historical conversation data from Claude Code and OpenAI Codex CLIs. Use when you need to understand a user's coding patterns, learn about a project from past sessions, or bootstrap agent memory from historical context.
---

# Migrating from Codex and Claude Code

This skill helps you discover, search, and extract useful information from historical Claude Code and OpenAI Codex conversations stored on the user's machine.

## When to Use This Skill

- During `/init` to bootstrap agent memory with project context
- When the user asks about their previous coding sessions
- To understand coding patterns, preferences, or project history
- To find context about a specific project or problem the user worked on before

## Scripts

This skill includes ready-to-use scripts for common operations:

| Script | Purpose |
|--------|---------|
| `scripts/detect.sh` | Detect available history and show summary |
| `scripts/list-sessions.sh` | List sessions for a project |
| `scripts/search.sh` | Search across all history by keyword |
| `scripts/view-session.sh` | View a session in readable format |

### Quick Start

```bash
# Detect what history data exists
./scripts/detect.sh

# List sessions for current project
./scripts/list-sessions.sh claude
./scripts/list-sessions.sh codex

# Search for a keyword across all history
./scripts/search.sh "database migration"
./scripts/search.sh "auth" --claude --project /path/to/project

# View a specific session
./scripts/view-session.sh ~/.claude/projects/-path-to-project/session.jsonl
./scripts/view-session.sh session.jsonl --tools --thinking
```

## Data Locations

### Claude Code (`~/.claude/`)

| Path | Contents |
|------|----------|
| `history.jsonl` | Global prompt history (all projects) - **always available** |
| `projects/<encoded-path>/` | Per-project conversation sessions - **may not exist for older projects** |
| `projects/<encoded-path>/sessions-index.json` | Quick session metadata lookup |
| `projects/<encoded-path>/<session-uuid>.jsonl` | Full conversation history |
| `settings.json` | User preferences (model, plugins) |

**Path Encoding**: Claude encodes project paths by replacing `/` with `-`:
- `/Users/foo/repos/myproject` → `-Users-foo-repos-myproject`

**Important**: Session files may not exist for older projects (cleaned up or not persisted). In this case, `history.jsonl` still contains the user's prompts but not full conversations. The scripts will automatically fall back to searching history.jsonl.

### OpenAI Codex (`~/.codex/`)

| Path | Contents |
|------|----------|
| `history.jsonl` | Global prompt history |
| `sessions/<year>/<month>/<day>/rollout-*.jsonl` | Session files by date |
| `config.toml` | User config (model, trusted projects) |

## Quick Searches

### Find Sessions for Current Project

```bash
# For Claude Code - encode current path
ENCODED=$(pwd | sed 's|/|-|g')
ls ~/.claude/projects/$ENCODED/ 2>/dev/null

# Check sessions index for quick metadata
cat ~/.claude/projects/$ENCODED/sessions-index.json 2>/dev/null | jq '.entries[] | {firstPrompt, messageCount, modified}'

# If session files don't exist, search history.jsonl instead
cat ~/.claude/history.jsonl | jq --arg p "$(pwd)" 'select(.project == $p)'
```

### Search by Project Name (Fallback)

When session files don't exist (older/cleaned up projects), search history.jsonl:

```bash
# Search by exact project path
cat ~/.claude/history.jsonl | jq 'select(.project == "/path/to/project")'

# Search by project name (partial match)
cat ~/.claude/history.jsonl | jq 'select(.project | contains("project-name"))'

# List all prompts for a project
cat ~/.claude/history.jsonl | jq -r 'select(.project | contains("myproject")) | "\(.timestamp / 1000 | strftime("%Y-%m-%d %H:%M"))  \(.display[0:80])..."'
```

### Search Prompt History

```bash
# Claude - search all prompts
cat ~/.claude/history.jsonl | jq 'select(.display | test("keyword"; "i"))' 

# Codex - search all prompts
cat ~/.codex/history.jsonl | jq 'select(.text | test("keyword"; "i"))'
```

### Find User Messages in Sessions

```bash
# Claude - extract user messages from a session
cat ~/.claude/projects/<path>/<session>.jsonl | jq 'select(.type == "user") | .message.content'

# Codex - extract user messages from a session  
cat ~/.codex/sessions/<path>/rollout-*.jsonl | jq 'select(.type == "event_msg" and .payload.type == "user_message") | .payload.message'
```

### Analyze Tool Usage Patterns

```bash
# Claude - what tools does the user's assistant use most?
cat ~/.claude/projects/<path>/<session>.jsonl | jq 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' | sort | uniq -c | sort -rn

# Codex - tool usage
cat ~/.codex/sessions/<path>/rollout-*.jsonl | jq 'select(.type == "response_item" and .payload.type == "function_call") | .payload.name' | sort | uniq -c | sort -rn
```

## Extracting Context for Memory Blocks

### Projects the User Has Worked On

```bash
# Claude - list all projects with activity counts
cat ~/.claude/history.jsonl | jq -s 'group_by(.project) | map({project: .[0].project, count: length}) | sort_by(-.count)'
```

### Recent Session Summaries

Claude sessions may contain summary entries:
```bash
cat ~/.claude/projects/<path>/<session>.jsonl | jq 'select(.type == "summary") | .summary'
```

### Common Workflows/Commands

Look for patterns in Bash tool calls:
```bash
cat ~/.claude/projects/<path>/<session>.jsonl | jq 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == "Bash") | .input.command' | head -20
```

## Populating Memory Blocks

When using historical data to populate memory blocks:

1. **`human` block**: Add insights about:
   - Projects they work on frequently
   - Coding preferences (tools, languages, frameworks)
   - Communication style (concise vs detailed)

2. **`project` block**: Add context about:
   - Tech stack (detected from tool calls)
   - Common commands (build, test, lint)
   - File patterns frequently accessed

## Detailed Format Documentation

For complete format specifications, see:
- [references/claude-format.md](references/claude-format.md) - Claude Code JSONL structure
- [references/codex-format.md](references/codex-format.md) - OpenAI Codex JSONL structure
