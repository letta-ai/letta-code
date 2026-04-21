---
name: external-history
description: Access and process session data from external coding agents (Claude Code, Codex, etc.). Load when migrating knowledge into memory via /migrate, or when you need to look up past sessions from other agent tools.
---

# External Agent History

Procedural knowledge for finding, reading, and processing session data from external coding agents.

## Supported Agents

| Agent | History Location | Session Files | Format |
|-------|-----------------|---------------|--------|
| Claude Code | `~/.claude/history.jsonl` | `~/.claude/projects/<encoded-path>/*.jsonl` | JSONL — `.timestamp` (ms), `.display`, `.project` |
| Codex | `~/.codex/history.jsonl` | `~/.codex/sessions/*.jsonl` | JSONL — `.ts` (seconds), `.text`, `.payload.cwd` |

More agents (Clawdbot, OpenClaw, OpenCode, etc.) can be added as their data formats are documented.

## Scripts

All scripts are in `scripts/` relative to this skill.

### detect-history.sh
Detect what external agent history exists on this machine.
```bash
bash scripts/detect-history.sh [project-path]
```
Shows: prompt counts, project session counts, total sizes, configured models.

### list-sessions.sh
List sessions for a specific project from either source.
```bash
bash scripts/list-sessions.sh <claude|codex> [project-path]
```
Uses `sessions-index.json` for Claude when available (faster), falls back to parsing individual JSONL files.

### search-history.sh
Search across agent history by keyword.
```bash
bash scripts/search-history.sh <keyword> [--claude|--codex|--both] [--project path]
```
Searches both global prompt history and session files. Results include timestamps and context.

### view-session.sh
View a session file in readable format.
```bash
bash scripts/view-session.sh <session-file> [--tools] [--thinking]
```
Auto-detects Claude vs Codex format. Flags control whether tool calls and thinking blocks are shown.

## Data Format Details

### Claude Code
- **Global history** (`history.jsonl`): One JSON object per line. Key fields: `timestamp` (ms since epoch), `display` (user prompt text), `project` (absolute path).
- **Session files** (`projects/<encoded>/*.jsonl`): Full conversation. Types: `user`, `assistant`, `summary`. User messages have `.message.content` (string or array). Assistant messages have `.message.content[]` with `.type` = `text`, `thinking`, or `tool_use`.
- **Session index** (`sessions-index.json`): `.entries[]` with `modified`, `messageCount`, `firstPrompt`.
- **Project path encoding**: `/Users/foo/bar` → `-Users-foo-bar` (leading `/` replaced by `-`, all `/` → `-`).

### Codex
- **Global history** (`history.jsonl`): One JSON object per line. Key fields: `ts` (seconds since epoch), `text` (user prompt).
- **Session files** (`sessions/*.jsonl`): Full conversation. First line is `session_meta` with `.payload.cwd`, `.payload.model_provider`, `.payload.git.branch`. Messages: `event_msg` with `.payload.type` = `user_message` (`.payload.message`), `agent_reasoning`; `response_item` with `.payload.type` = `message` (`.payload.content[].text`), `function_call`, `function_call_output`.
