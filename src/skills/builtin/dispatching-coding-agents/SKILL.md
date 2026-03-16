---
name: dispatching-coding-agents
description: Dispatch stateless coding agents which lack memory, but have isolated context and run in a different harness (Claude Code or Codex). Use these other agents when you need help for especially difficult tasks (for example, if you are looping or hitting a wall) or need a second opinion. 
---

# Dispatching Coding Agents

You can shell out to **Claude Code** (`claude`) and **Codex** (`codex`) as stateless sub-agents via Bash. They have full filesystem and tool access but **zero memory** — you must provide all necessary context in the prompt.

## Using Claude Code and Codex as subagents
Claude Code and Codex are highly optimized coding agents, but are re-born with each new session. Think of them like a brilliant intern that showed up today. They know nothing, but may sometimes have a fresher perspective in part due to their naivety. In addition, their complete clueleness means you can give them just the right amount of context to maximize performance with minimal context bloat. 

You are the experienced agent manager that interfaces with the user, and has already learned about the user and their work through experience and the ability to form memories and learn. When using Claude Code or Codex as subagents, you need to provide them with any context they might need for them to perform their best. This includes: 
* **Detailed task desription**: Explain exactly what you need them to to. Be specific - tell them exactly what to investigate or implement and what files to look at. 
* **Relevant context**: Provide any relevant filepaths (e.g. parts of the code, reference materials) and important high-level context (e.g. details about the code architecture)
* **High level guidance**: Communicate any preferences or general guidance that you are aware of. Help them avoid having to be corrected by the user. 

Remember, they wont know anything unless you provide the information to them. Once you have initiated a session, you can continue interacting the the same session which will persist the same context and message histories (though the subagent's context may eventaully be compacted). Creating a new session will wipe all messages. If subagents ask for clarification or require feedback, respond to them in the same session to avoid losing the conversation. 

## Deciding on which subagent to use
Different agents have different strength and weaknesses. Choose your subagent's configuration accordingly. You should update your memory with observations about how these agents perform for the tasks you give them to rely on your own analysis over time. Below are initial recommendations for agents: 

Codex (Codex 5.3) 
* Strengths: Frontier reasoning, excellent at debugging, best option for the hardest tasks
* Weaknesses: Slow with long trajectories, designed primarily for coding, compactions can destroy trajectories

Codex (GPT 5.4) 
* Strengths: Easier for humans to understand, general-purpose, faster 
* Weaknesses: More likely to make silly errors than Codex 5.3

Claude Code (Opus 4.6) 
* Strengths: Excellent writer, understands vague instructions, excellent for coding but also general-purpose
* Weaknesses: Tends to generate "slop", writing excessive quantities of code unnecessary

## Learning from your subagents
Once your subagents have completed, you can use the `history-analyzer` subagent to access past Claude Code and Codex sessions and see if they have discovered anything potentially relevant for future tasks, or to evaluate their performance to inform future subagent invocations. 

## Invoking coding subagents

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

Have one agent write code or create a plan (in a `.md` file), then dispatch the other to review it:
```bash
claude -p "Review the changes in this diff for correctness and edge cases: $(git diff)" --model opus
```

### Get outside feedback
Ask a subagent for feedback on your plan file, or provide it with instructions on how to view your message history to ask for outside feedback. 

## Timeouts

Set appropriate Bash timeouts for these calls — they can take a while:
- Research/analysis: `timeout: 300000` (5 min)
- Implementation: `timeout: 600000` (10 min)
