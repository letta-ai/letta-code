---
name: dispatching-coding-agents
description: Dispatch coding agents (Claude Code or Codex) via Bash. Use when you're stuck, need a second opinion, or need parallel research on a hard problem. They do not inherit this conversation or its memory, so provide the relevant context.
---

# Dispatching Coding Agents

Shell out to Claude Code (`claude`) or Codex (`codex`) when an independent coding agent would help. These agents can inspect and modify the filesystem, but they do not inherit your memory or conversation context.

Default to `run_in_background: true` on the Bash call. Keep working while the process runs, then read its result with `TaskOutput` using the returned task ID.

## Before Dispatching

CLI interfaces and model catalogs change. Check the installed command instead of relying on remembered flags or model names:

```bash
command -v claude && claude --version && claude --help
command -v codex && codex --version && codex exec --help
```

Use each CLI's configured default model unless the user explicitly requests a model. If a requested model is rejected, inspect the current CLI/account configuration and use a supported option rather than guessing another versioned name.

Use an absolute repository path. Claude Code inherits the shell's current directory, so change directories in the shell command. Codex supports `-C` for its working root.

## The Core Mental Model

Treat a dispatched agent like a capable new collaborator with no project history. Give it the context it cannot discover efficiently:

- **Specific task**: Ask for a concrete result, not a broad topic.
- **Repository and key files**: Include the absolute repo path and likely entry points.
- **Relevant architecture**: Explain how the pieces connect.
- **Constraints**: Include scope, style, safety, and user preferences.
- **Prior work**: Describe attempted approaches and known dead ends.
- **Expected output**: Request a diff, root-cause analysis, file list, or review verdict.

Give the agent context and constraints, not a prescribed implementation plan. Let it independently inspect the evidence and propose an approach.

## When to Dispatch

Good uses:

- Hard debugging where fresh eyes would help
- Independent review of a plan or diff
- Parallel investigation of distinct hypotheses
- Broad codebase tracing across many files
- A contained implementation in an isolated worktree

Work directly instead for simple reads, searches, small edits, or tasks where transferring context costs more than doing the work.

## Prompt Template

```text
TASK: [one-sentence objective]

CONTEXT:
- Repo: [absolute path]
- Key files: [specific paths and responsibilities]
- Architecture: [relevant flow]

WHAT TO DO:
[precise investigation or implementation request]

CONSTRAINTS:
- [scope and project conventions]
- [user preferences]
- [attempts or dead ends]

OUTPUT:
[exact result to return]
```

## Durable Invocation Patterns

### Claude Code

Run from the target repository and request structured output so the session ID is available for follow-up:

```bash
cd "/absolute/path/to/repo" && claude -p "YOUR PROMPT" --output-format json
```

For read-only research, inspect `claude --help` and restrict its tools to the current read/search tool names. For implementation, use the permission mode appropriate to the surrounding environment. Permission bypass is appropriate only when the process is already isolated by a sandbox or disposable worktree and the task warrants unrestricted execution.

### Codex

Use a read-only sandbox for investigation:

```bash
codex exec -C "/absolute/path/to/repo" --sandbox read-only --json "YOUR PROMPT"
```

Use a writable sandbox for implementation in an isolated worktree:

```bash
codex exec -C "/absolute/path/to/repo" --sandbox workspace-write --json "YOUR PROMPT"
```

Check `codex exec --help` before adding optional approval, search, or model flags. Prefer the current explicit sandbox controls over deprecated convenience flags.

### Parallel research

Launch separate Bash calls in one message with `run_in_background: true`. Give each agent the same evidence but a distinct hypothesis or review angle, then compare their conclusions against the source yourself.

### Code review

Codex has a native non-interactive review command. Confirm its current options first:

```bash
codex review --help
cd "/absolute/path/to/repo" && codex review --uncommitted
```

Claude Code can review from the working tree directly; tell it to inspect `git diff` rather than embedding a potentially large diff in the shell command.

## Sessions and Follow-up

Preserve the session identifier from structured output. Resume the same session when asking a follow-up so the dispatched agent retains what it already inspected:

```bash
cd "/absolute/path/to/repo" && claude -r SESSION_ID -p "Follow-up prompt" --output-format json
cd "/absolute/path/to/repo" && codex exec resume --json SESSION_ID "Follow-up prompt"
```

Run the corresponding `--help` command if the installed CLI rejects a resume form. Do not infer a session ID by scraping private on-disk storage layouts.

## Handling Failures

Classify the failure before retrying:

- **Command missing**: Report which CLI is unavailable or dispatch the other one.
- **Unknown/deprecated option**: Re-read the installed command's `--help` and rebuild the invocation from supported flags.
- **Unsupported model**: Remove the model override or use an option verified for the current account.
- **Authentication, quota, or service error**: Preserve the exact error; changing the prompt will not fix it.
- **Timeout**: Inspect partial output, narrow the task, and resume the same session when possible.
- **Poor result**: Add missing files, constraints, prior attempts, and a more precise output contract.

A launched process is not proof of a successful dispatch. Verify that it completed an agent turn and returned the requested output before relying on its conclusions.
