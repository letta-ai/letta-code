---
name: dispatching-coding-agents
description: Dispatch tasks to Claude Code and Codex CLI agents via Bash. Use when you want a second opinion, need to parallelize research across models, or face a hard coding problem that benefits from a stateless agent with frontier reasoning. Covers non-interactive execution, model selection, session resumption, and the history-analyzer subagent for accessing their past sessions.
---

# Dispatching Coding Agents

You can shell out to **Claude Code** (`claude`) and **Codex** (`codex`) as stateless sub-agents via Bash. They have full filesystem and tool access but **zero memory** — you must provide all necessary context in the prompt.

## Philosophy

You are the experienced manager with persistent memory. Claude Code and Codex are high-intellect but stateless — reborn fresh every invocation. Your job:

1. **Provide context** — include relevant file paths, architecture context, and constraints from your memory
2. **Be specific** — tell them exactly what to investigate or implement, and what files to look at
3. **Run async when possible** — use `run_in_background: true` on Bash calls to avoid blocking
4. **Learn from results** — track which models/agents perform better on which tasks, and update memory
5. **Mine their history** — use the `history-analyzer` subagent to access past Claude Code and Codex sessions

## Non-Interactive Execution

### Claude Code

```bash
claude -p "YOUR PROMPT" --model MODEL --dangerously-skip-permissions
```

- `-p` / `--print`: non-interactive mode, prints response and exits
- `--dangerously-skip-permissions`: use in trusted repos to skip approval prompts. Without this, killed/timed-out sessions can leave stale approval state that blocks future runs with "stale approval from interrupted session" errors.
- `--model MODEL`: alias (`sonnet`, `opus`) or full name (`claude-sonnet-4-6`)
- `--effort LEVEL`: `low`, `medium`, `high` — controls reasoning depth
- `--append-system-prompt "..."`: inject additional system instructions
- `--allowedTools "Bash Edit Read"`: restrict available tools
- `--max-budget-usd N`: cap spend for the invocation
- `-C DIR`: set working directory

Example — research task with Opus:
```bash
claude -p "Trace the request flow from POST /agents/{id}/messages through to the LLM call. Cite files and line numbers." \
  --model opus --dangerously-skip-permissions -C /path/to/repo
```

### Codex

```bash
codex exec "YOUR PROMPT" -m codex-5.3 --full-auto
```

- `exec`: non-interactive mode
- `-m MODEL`: prefer `codex-5.3` (frontier), also `gpt-5.2`, `o3`
- `--full-auto`: auto-approve commands in sandbox (equivalent to `-a on-request --sandbox workspace-write`)
- `-C DIR`: set working directory
- `--search`: enable web search tool

Example — research task:
```bash
codex exec "Find all places where system prompt is recompiled. Cite files and line numbers." \
  -m codex-5.3 --full-auto -C /path/to/repo
```

## Session Resumption

Both CLIs persist sessions to disk. Use resumption to continue a line of investigation.

### Claude Code

```bash
# Resume by session ID
claude -r SESSION_ID -p "Follow up: now check if..."

# Continue most recent session in current directory
claude -c -p "Also check..."

# Fork a session (new ID, keeps history)
claude -r SESSION_ID --fork-session -p "Try a different approach..."
```

### Codex

```bash
# Resume by session ID (interactive)
codex resume SESSION_ID "Follow up prompt"

# Resume most recent session
codex resume --last "Follow up prompt"

# Fork a session (new ID, keeps history)
codex fork SESSION_ID "Try a different approach"
codex fork --last "Try a different approach"
```

Note: Codex `resume` and `fork` launch interactive sessions, not non-interactive `exec`. For non-interactive follow-ups with Codex, start a fresh `exec` and include relevant context from the previous session in the prompt.

## Capturing Session IDs

When you dispatch a task, capture the session ID so you can access the full session history later. The Bash output you get back is just the final summary — the full session (intermediate tool calls, files read, reasoning) is stored locally and contains much richer data.

### Claude Code

Use `--output-format json` to get structured output including the session ID:
```bash
claude -p "YOUR PROMPT" --model opus --dangerously-skip-permissions --output-format json 2>&1
```
The JSON response includes `session_id`, `cost_usd`, `duration_ms`, `num_turns`, and `result`.

Session files are stored at:
```
~/.claude/projects/<encoded-path>/<session-id>.jsonl
```
Where `<encoded-path>` is the working directory with `/` replaced by `-` (e.g. `/Users/foo/repos/bar` → `-Users-foo-repos-bar`).

### Codex

Codex prints the session ID in its output header:
```
session id: 019c9b76-fff4-7f40-a895-a58daa3c74c6
```
Extract it with: `grep "^session id:" output | awk '{print $3}'`

Session files are stored at:
```
~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl
```

## Session History

Both CLIs persist full session data (tool calls, reasoning, files read) locally. This is richer than the summarized output you get back in Bash.

### Where sessions are stored

**Claude Code:**
```
~/.claude/projects/<encoded-path>/<session-id>.jsonl
```
Where `<encoded-path>` is the working directory with `/` replaced by `-` (e.g. `/Users/foo/repos/bar` → `-Users-foo-repos-bar`). Use `--output-format json` to get the `session_id` in structured output.

**Codex:**
```
~/.codex/sessions/<year>/<month>/<day>/rollout-*-<session-id>.jsonl
```
The session ID is printed in the output header: `session id: <uuid>`.

### When to analyze sessions

**Don't** run history-analyzer after every dispatch — the reflection agent already captures insights from your conversation naturally, and single-session analysis tends to produce overly detailed memory that's better represented by the code itself.

**Do** use `history-analyzer` for its intended purpose: **bulk migration** when bootstrapping memory from months of accumulated Claude Code/Codex history (e.g. during `/init`). For that, see the `migrating-from-codex-and-claude-code` skill.

Session files are useful for:
- **Resuming** a line of investigation (see Session Resumption above)
- **Reviewing** what an agent actually did (read the JSONL directly)
- **Bulk migration** during `/init` when you have no existing memory

## Dispatch Patterns

### Parallel research — get multiple perspectives

Run Claude Code and Codex simultaneously on the same question via separate Bash calls in a single message. Compare results for higher confidence.

### Deep investigation — use frontier models

For hard problems, use the strongest available models:
- Codex: `-m codex-5.3` (preferred — strong reasoning, good with large repos)
- Claude Code: `--model opus`

### Code review — cross-agent validation

Have one agent write code, then dispatch the other to review it:
```bash
claude -p "Review the changes in this diff for correctness and edge cases: $(git diff)" --model opus
```

### Scoped implementation — sandboxed changes

Use Codex with `--full-auto` or Claude Code with `--dangerously-skip-permissions` (in trusted repos only) for autonomous implementation tasks. Always review their changes via `git diff` before committing.

## Timeouts

Set appropriate Bash timeouts for these calls — they can take a while:
- Research/analysis: `timeout: 300000` (5 min)
- Implementation: `timeout: 600000` (10 min)

## Strengths & Weaknesses (update as you learn)

Track observations about model/agent performance in memory. Initial heuristics:

| Agent | Strengths | Weaknesses |
|-------|-----------|------------|
| Codex (Codex-5.3) | Frontier reasoning, handles large repos well, reliable with --full-auto | Most expensive |
| Codex (GPT-5.2) | Strong reasoning, good code search | Slightly less capable than 5.3 |
| Claude Code (Sonnet) | Fast, actionable output with concrete code samples | Less thorough on edge cases |
| Claude Code (Opus) | Deep analysis, nuanced reasoning | Can hang on large repos with tool use, needs --dangerously-skip-permissions |
