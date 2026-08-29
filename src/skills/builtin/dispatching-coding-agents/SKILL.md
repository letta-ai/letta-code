---
name: dispatching-coding-agents
description: Dispatch stateless coding agents through Claude Code or Codex. Model catalog checked 2026-08-25: Claude Code includes Sonnet 5, Opus 5, and Fable 5; Codex includes GPT-5.6 Luna, Terra, and Sol. Use when you're stuck, need a second opinion, or need parallel research on a hard problem. They have no memory, so you must provide all context.
---

# Dispatching Coding Agents

You can shell out to **Claude Code** (`claude`) and **Codex** (`codex`) as stateless sub-agents via Bash. They have filesystem and tool access (scope depends on sandbox/approval settings) but **zero memory** — every session starts from scratch.

**Default to `run_in_background: true`** on the Bash call so you can keep working while they run. Check results later with `TaskOutput`. Don't sit idle waiting for a subagent.

## The Core Mental Model

Claude Code and Codex are highly optimized coding agents, but are re-born with each new session. Think of them like a brilliant intern that showed up today. Provide them with the right instructions and context to help them succeed and avoid having to re-learn things that you've learned.

You are the experienced manager with persistent memory of the user's preferences, the codebase, past decisions, and hard-won lessons. **Give them context, not a plan.** They won't know anything you don't tell them:

- **Specific task**: Be precise about what you need — not "look into the auth system" but "trace the request flow from the messages endpoint through to the LLM call, cite files and line numbers."
- **File paths and architecture**: Tell them exactly where to look and how pieces connect. They will wander aimlessly without this.
- **Preferences and constraints**: Code style, error handling patterns, things the user has corrected you on. Save them from making mistakes you already learned from.
- **What you've already tried**: If you're dispatching because you're stuck, this prevents them from rediscovering your dead ends.

If a subagent needs clarification or asks a question, respond in the same session (see Session Resumption below) — don't start a new session or you'll lose the conversation context.

## When to Dispatch (and When Not To)

### Dispatch for:
- **Hard debugging** — you've been looping on a problem and need fresh eyes
- **Second opinions** — you want validation before a risky change
- **Parallel research** — investigate multiple hypotheses simultaneously
- **Large-scope investigation** — tracing a flow across many files in an unfamiliar area
- **Code review** — have another agent review your diff or plan

### Don't dispatch for:
- Simple file reads, greps, or small edits — faster to do yourself
- Anything that takes less than ~3 minutes of direct work
- Tasks where you already know exactly what to do
- When context transfer would take longer than just doing the task

## Choosing an Agent and Model

Different agents have different strengths. Track what works in your memory over time — your own observations are more valuable than these defaults.

### Categories

**Codex (catalog checked 2026-08-25):**
- `gpt-5.6-luna`: high-throughput, lower-latency work
- `gpt-5.6-terra`: strong performance with a balance of intelligence and cost
- `gpt-5.6-sol`: quality-first flagship for difficult coding and reasoning
- Use the configured default unless the user requests a model. Pass a requested model with `-m`, for example `codex exec "YOUR PROMPT" -m gpt-5.6-sol --sandbox workspace-write`.
- If a requested model is rejected, inspect the installed CLI and account configuration rather than guessing another model name.

**Claude Code (catalog checked 2026-08-25):**
- The current flagship models are Sonnet 5, Opus 5, and Fable 5. Use the configured default unless the user requests a model.
- Claude Code's stable aliases follow its current catalog:
  - `best`: highest-capability model available to the account, using Fable 5 when available
  - `fable`: Fable 5 for the hardest, longest-running tasks
  - `opus`: Opus 5 for complex reasoning, docs, refactors, and open-ended tasks
  - `sonnet`: Sonnet 5 for everyday coding
  - `haiku`: fast, simple tasks
- Pass an alias with `--model`, for example `claude -p "YOUR PROMPT" --model fable --dangerously-skip-permissions`.
- Aliases update as Claude Code's catalog changes. If an alias is rejected, inspect the installed CLI version and account access rather than guessing a versioned model name.

### Cost and speed tradeoffs
- Use each CLI's configured default model unless the task requires a model the user explicitly requested
- Use `--max-budget-usd N` (Claude Code) to cap spend on exploratory tasks

### Known quirks
- **Claude Code can hang on large repos** with unrestricted tools — consider `--tools "Read,Grep,Glob"` (no Bash) and shorter timeouts for research tasks
- **Codex compactions can destroy long trajectories** — for very long tasks, prefer multiple shorter sessions over one marathon
- **Opus tends to over-generate** — produces more code than necessary. Good for exploration, verify before applying.

## Prompting Subagents

### Prompt template
```
TASK: [one-sentence summary]

CONTEXT:
- Repo: [path]
- Key files: [list specific files and what they contain]
- Architecture: [brief relevant context]

WHAT TO DO:
[what you need done — be precise, but let them figure out the approach]

CONSTRAINTS:
- [any preferences, patterns to follow, things to avoid]
- [what you've already tried, if dispatching because stuck]

OUTPUT:
[what you want back — a diff, a list of files, a root cause analysis, etc.]
```

### What makes a good prompt
- **Be specific about files** — "look at `src/agent/message.ts` lines 40-80" not "look at the message handling code"
- **State the output format** — "return a bullet list of findings" vs. leaving it open-ended
- **Include constraints** — if the user prefers certain patterns, say so explicitly
- **Provide what you've tried** — when dispatching because you're stuck, this prevents them from repeating your dead ends

## Dispatch Patterns

### Parallel research — multiple perspectives
Run Claude Code and Codex simultaneously on the same question via separate Bash calls in a single message (use `run_in_background: true`). Compare results for higher confidence.

### Background dispatch — keep working while they run
Use `run_in_background: true` on the Bash call to dispatch async. Continue your own work, then check results with `TaskOutput` when ready.

### Deep investigation
For hard problems, use the configured model in a writable sandbox:
```bash
codex exec "YOUR PROMPT" --sandbox workspace-write -C /path/to/repo
```

Claude Code does not support a `-C` working-directory flag. Use `cd /path/to/repo && claude ...` inside the Bash command. Use `--add-dir` only to grant access to additional directories outside the current working directory.

### Code review — cross-agent validation
Have one agent write code or create a plan, then dispatch another to review:
```bash
# Codex has a native review command:
codex review --uncommitted    # Review all local changes
codex review "Focus on error handling and edge cases"

# Claude Code — pass the diff inline:
claude -p "Review the following diff for correctness, edge cases, and missed error handling:\n\n$(git diff)" \
  --model opus --dangerously-skip-permissions
```

### Get outside feedback on your work
Write your plan or analysis to a file, then ask a subagent to critique it:
```bash
cd /path/to/repo && claude -p "Read /tmp/my-plan.md and critique it. What am I missing? What could go wrong?" \
  --model opus --dangerously-skip-permissions
```

## Handling Failures

- **Timeout**: If an agent times out (especially Claude Code on large repos), try: (1) a shorter, more focused prompt, (2) restricting tools with `--tools`, (3) switching to Codex which handles large repos better
- **Garbage output**: If results are incoherent, the prompt was probably too vague. Rewrite with more specific file paths and clearer instructions.
- **Session errors**: Claude Code can hit "stale approval from interrupted session" — `--dangerously-skip-permissions` prevents this. If Codex errors, start a fresh `exec` session.
- **Compaction mid-task**: If a Codex session runs long enough to compact, it may lose earlier context. Break long tasks into smaller sequential sessions.

## CLI Reference

### Claude Code

```bash
claude -p "YOUR PROMPT" --model MODEL --dangerously-skip-permissions
```

| Flag | Purpose |
|------|---------|
| `-p` / `--print` | Non-interactive mode, prints response and exits |
| `--dangerously-skip-permissions` | Skip approval prompts (prevents stale approval errors on timeout) |
| `--model MODEL` | Alias or model name accepted by the installed CLI; omit to use the configured default |
| `--effort LEVEL` | `low`, `medium`, `high`, `xhigh`, `max` — controls reasoning depth |
| `--append-system-prompt "..."` | Inject additional system instructions |
| `--allowedTools "Bash(git log *)" "Read"` | Tools that execute without prompting for permission |
| `--tools "Bash,Edit,Read"` | Restrict which built-in tools are available |
| `--max-budget-usd N` | Cap spend for the invocation |
| `--add-dir DIR` | Allow access to an additional directory; does not change the working directory |
| `--output-format json` | Structured output with `session_id`, `cost_usd`, `duration_ms` |

Set Claude Code's working directory with `cd /path/to/repo && claude ...` in the Bash command, not with a Claude flag.

### Codex

```bash
codex exec "YOUR PROMPT" --sandbox workspace-write
```

| Flag | Purpose |
|------|---------|
| `exec` | Non-interactive mode |
| `-m MODEL` | Model accepted by the installed CLI; omit to use the configured default |
| `--sandbox MODE` | Select a read-only or writable sandbox |
| `-C DIR` | Set working directory |
| `--search` | Enable web search tool |
| `review` | Native code review — `codex review --uncommitted` or `codex review "prompt"` |

## Session Management

Both CLIs persist full session data (tool calls, reasoning, files read) to disk. The Bash output you see is just the final summary — the local session file is much richer.

### Session storage paths

**Claude Code:** `~/.claude/projects/<encoded-path>/<session-id>.jsonl`
- `<encoded-path>` = working directory with `/` replaced by `-` (e.g. `/Users/foo/repos/bar` becomes `-Users-foo-repos-bar`)
- Use `--output-format json` to get the `session_id` in the response

**Codex:** `~/.codex/sessions/<year>/<month>/<day>/rollout-*-<session-id>.jsonl`
- Session ID is printed in output header: `session id: <uuid>`
- Extract with: `grep "^session id:" output | awk '{print $3}'`

### Resuming sessions

Use session resumption to continue a line of investigation without re-providing all context:

**Claude Code:**
```bash
claude -r SESSION_ID -p "Follow up: now check if..."    # Resume by ID
claude -c -p "Also check..."                             # Continue most recent
claude -r SESSION_ID --fork-session -p "Try differently" # Fork (new ID, keeps history)
```

**Codex:**
```bash
codex exec resume SESSION_ID "Follow up prompt"  # Resume by ID (non-interactive)
codex exec resume --last "Follow up prompt"      # Resume most recent (non-interactive)
codex resume SESSION_ID "Follow up prompt"       # Resume by ID (interactive)
codex resume --last "Follow up prompt"           # Resume most recent (interactive)
codex fork SESSION_ID "Try a different approach" # Fork session (interactive)
```

Note: `codex exec resume` works non-interactively. `codex resume` and `codex fork` are interactive only.

### When to analyze past sessions

**Don't** run `history-analyzer` after every dispatch — your reflection agent already captures insights naturally, and single-session analysis produces overly detailed notes.

**Do** use `history-analyzer` for **bulk migration** when bootstrapping memory from months of accumulated history (e.g. during `/init`). See the `initializing-memory` skill's historical session analysis reference.

Direct uses for session files:
- **Resume** an investigation (see above)
- **Review** what an agent actually did (read the JSONL file directly)
- **Bulk migration** when setting up a new agent

## Timeouts

Set Bash timeouts appropriate to the task:
- Quick checks / reviews: `timeout: 120000` (2 min)
- Research / analysis: `timeout: 300000` (5 min)
- Implementation: `timeout: 600000` (10 min)
