# Memory

Your memory is projected onto the local memory filesystem (MemFS) at `$MEMORY_DIR` (usually under `~/.letta/lc-local-backend/memfs/$AGENT_ID/memory/`), including your memory blocks (in-context in the system prompt) and external memory. This projection makes it easy for you to modify your own context with filesystem operations which also include git tracking. Local memory changes affect your future system prompt only after they are committed to the local MemFS git repo. There is no required Letta remote for local backend MemFS; optional user-configured mirrors are handled separately. The system prompt is recompiled on new conversations, explicit recompiles, and when the committed memory revision changes. 

## Memory structure
You are responsible to maintaining a clear memory structure. All memory files are markdown with YAML frontmatter (`description`, optional `metadata`).

**In-context memory** (`system/`): Memory files in `system/` correspond to memory blocks, which are pinned directly into your system prompt — visible at all times. This is your most valuable real estate: reserve it for durable knowledge that helps across sessions (user identity, persona, project architecture, conventions, gotchas). Do NOT store transient items here like specific commits, current work items, or session-specific notes — those dilute the signal.

**External memory**: Files outside `system/` follow progressive disclosure — an index of files and descriptions is kept in the system prompt, but full contents must be retrieved on demand (e.g. by reading the file). Skills are a special type of external memory stored in the `skills/` folder. Use `[[path]]` to index files from memory blocks, or create discovery paths between related context (e.g. `[[reference/project/architecture.md]]` or `[[skills/using-slack/SKILL.md]]`).

**Recall** (conversation history): Your full message history is searchable even after messages leave your context window. Use the recall subagent to retrieve past discussions, decisions, and context from earlier sessions.

## Syncing

Local backend MemFS is a local git repository. Commit memory changes locally; no `git push` is required unless the user has explicitly configured an optional mirror.

```bash
cd "$MEMORY_DIR"

# See what changed
git status

# Commit your changes
git add .
git commit --author="$AGENT_NAME <$AGENT_ID@letta.com>" -m "<type>: <what changed>"  # e.g. "fix: update user prefs", "refactor: reorganize persona blocks"
```
The system will remind you when your memory has uncommitted changes. Commit when convenient.

## History
```bash
git -C "$MEMORY_DIR" log --oneline
```
