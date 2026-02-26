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
claude -p "YOUR PROMPT" --model MODEL
```

- `-p` / `--print`: non-interactive mode, prints response and exits
- `--model MODEL`: alias (`sonnet`, `opus`) or full name (`claude-sonnet-4-6`)
- `--effort LEVEL`: `low`, `medium`, `high` — controls reasoning depth
- `--append-system-prompt "..."`: inject additional system instructions
- `--allowedTools "Bash Edit Read"`: restrict available tools
- `--max-budget-usd N`: cap spend for the invocation
- `-C DIR`: set working directory

Example — research task with Opus:
```bash
claude -p "Trace the request flow from POST /agents/{id}/messages through to the LLM call. Cite files and line numbers." \
  --model opus -C /path/to/repo
```

### Codex

```bash
codex exec "YOUR PROMPT" -m MODEL --full-auto
```

- `exec`: non-interactive mode
- `-m MODEL`: e.g. `o3`, `gpt-5.2`, `codex-5.3`
- `--full-auto`: auto-approve commands in sandbox (equivalent to `-a on-request --sandbox workspace-write`)
- `-C DIR`: set working directory
- `--search`: enable web search tool

Example — research task with GPT-5.2:
```bash
codex exec "Find all places where system prompt is recompiled. Cite files and line numbers." \
  -m gpt-5.2 --full-auto -C /path/to/repo
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

## Accessing History

Use the **`history-analyzer`** Task subagent to find and process past Claude Code and Codex sessions:

```
Task({
  subagent_type: "history-analyzer",
  description: "Analyze past coding sessions",
  prompt: "Find recent Claude Code and Codex sessions related to [topic]. Summarize key findings and update memory."
})
```

The history-analyzer knows where session data is stored and can extract insights from past conversations with these agents.

## Dispatch Patterns

### Parallel research — get multiple perspectives

Run Claude Code and Codex simultaneously on the same question via separate Bash calls in a single message. Compare results for higher confidence.

### Deep investigation — use frontier models

For hard problems, use the strongest available models:
- Claude Code: `--model opus`
- Codex: `-m codex-5.3` or `-m gpt-5.2`

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
| Claude Code (Opus) | Deep code tracing, nuanced analysis, long-context | Slower, more expensive |
| Claude Code (Sonnet) | Fast, good for straightforward tasks | Less thorough on complex traces |
| Codex (GPT-5.2) | Strong reasoning, good code search | Different tool ecosystem |
| Codex (Codex-5.3) | Frontier reasoning for hardest problems | Most expensive |
