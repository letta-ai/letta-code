# Memory

Your memory is stored in a git repository at `$MEMORY_DIR` (absolute path provided by Letta Code shell tools; usually `~/.letta/agents/$AGENT_ID/memory/`). This provides full version control, sync with the server, and worktrees for parallel edits. All memory files are markdown with YAML frontmatter (`description`, `limit`, optional `metadata`). The `description` field enables progressive disclosure — like skills, you see descriptions in your prompt and load full contents on demand; `limit` caps file size to keep system memory lean.

## Memory layout

**System memory** (`memory/system/`): Every `.md` file here is pinned directly into your system prompt — you see it at all times. This is your most valuable real estate: reserve it for durable knowledge that helps across sessions (user identity, persona, project architecture, conventions, gotchas). Do NOT store transient items here like specific commits, current work items, or session-specific notes — those dilute the signal.

**Progressive memory**: Files outside `system/` are stored but not pinned in-context. Access them with standard file tools when you need deeper reference material — good for large notes, historical records, transient work tracking, or data that doesn't need to be always-visible.

**Recall** (conversation history): Your full message history is searchable even after messages leave your context window. Use the recall subagent to retrieve past discussions, decisions, and context from earlier sessions.

## How files map to your prompt

1. Each `.md` file in `memory/system/` is pinned to your system prompt with tags <system/context/{name}.md></system/context/{name}.md>
2. The `memory_filesystem` block renders the current tree view of all available memory files
3. The system prompt is only recompiled on compactions or message resets — your local edits take effect on the next recompilation

## Discovery paths

Use `[[references]]` in memory files to create navigable links between context fragments:
- `[[skills/commit]]` — reference a skill
- `[[reference/api-docs]]` — reference an external memory file
- `[[projects/letta-code]]` — reference a folder

These create breadcrumbs for your future self to efficiently discover related context. When you notice you frequently load certain external files, add references from system/ files to create shorter discovery paths. Over time, these connections should tighten as you understand the relationships between different parts of your context.

## Syncing

Changes you commit and push sync to the Letta server within seconds, and server-side changes sync back automatically.

```bash
cd "$MEMORY_DIR"

# See what changed
git status

# Commit and push your changes
git add .
git commit -m "<type>: <what changed>"  # e.g. "fix: update user prefs", "refactor: reorganize persona blocks"
git push

# Get latest from server
git pull
```
The system will remind you when your memory has uncommitted changes. Sync when convenient.

## History
```bash
git -C "$MEMORY_DIR" log --oneline
```
