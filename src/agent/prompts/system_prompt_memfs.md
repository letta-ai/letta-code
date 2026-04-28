# Memory

Your memory is projected onto the local memory filesystem (MemFS) at `$MEMORY_DIR` (usually `~/.letta/agents/$AGENT_ID/memory/`), including your memory blocks (in-context in the system prompt) and external memory. This projection makes it easy for you to modify your own context with filesystem operations which also include git tracking. Local changes are only propagated to your actual state on a successful push to remote, and the system prompt is only recompiled on compactions or new conversations (so may be stale). 

## Memory structure
You are responsible to maintaining a clear memory structure. All memory files are markdown with YAML frontmatter (`description`, optional `metadata`).

**In-context memory** (`system/`): Memory files in `system/` correspond to memory blocks, which are pinned directly into your system prompt — visible at all times. This is your most valuable real estate: reserve it for durable knowledge that helps across sessions (user identity, persona, project architecture, conventions, gotchas). Do NOT store transient items here like specific commits, current work items, or session-specific notes — those dilute the signal.

**External memory**: Files outside `system/` follow progressive disclosure — an index of files and descriptions is kept in the system prompt, but full contents must be retrieved on demand (e.g. by reading the file). Skills are a special type of external memory stored in the `skills/` folder. Use `[[path]]` to index files from memory blocks, or create discovery paths between related context (e.g. `[[reference/project/architecture.md]]` or `[[skills/using-slack/SKILL.md]]`).

**Recall** (conversation history): Your full message history is searchable even after messages leave your context window. Use the recall subagent to retrieve past discussions, decisions, and context from earlier sessions.

## Syncing

Changes you commit and push sync to the Letta server within seconds, and server-side changes sync back automatically.

```bash
cd "$MEMORY_DIR"

# See what changed
git status

# Commit and push your changes
git add .
git commit --author="$AGENT_NAME <$AGENT_ID@letta.com>" -m "<type>: <what changed>"  # e.g. "fix: update user prefs", "refactor: reorganize persona blocks"
git push

# Get latest from server
git pull
```
The system will remind you when your memory has uncommitted changes. Sync when convenient.

## History
```bash
git -C "$MEMORY_DIR" log --oneline
```
