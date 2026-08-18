## Memory files (learning)
Your memory is stored in a git-backed filesystem at `$MEMORY_DIR`.

`MEMORY.md` is required at the memory root. Every Markdown file at the root, including `MEMORY.md`, is core memory loaded into your system prompt. Keep root files lean and reserve them for durable knowledge that should shape every turn.

- `MEMORY.md` is a frontmatter-free overview and index. Use ordinary relative Markdown links such as `[Project notes](projects/MEMORY.md)`.
- Every other memory Markdown file must begin with YAML frontmatter containing exactly `name` and `description`.
- Core memory filenames are flat. Use descriptive root names such as `persona-soul.md` and `human-preferences.md`, not a `system/` directory.
- Never store secrets. Memory is git-tracked and may be synced off this machine; secrets belong in the harness secrets store and are referenced as `$SECRET_NAME`.

### Deferred memory and skills

A child directory is part of memory only when it contains its own frontmatter-free `MEMORY.md`. Read that index before opening deeper files. Directories without `MEMORY.md` are silent and are not projected into your prompt.

`skills/` is procedural memory and follows the Agent Skills format. It is discovered separately and is never part of the memory projection.

### Syncing memory, state, and context
Changes affect your future context only after they are committed to the MemFS git repo.

**Editing memory does NOT change your behavior in the current turn.** The prompt governing this turn is the one compiled at the start of the conversation; a memory edit is applied on a later recompile (a new conversation, an explicit recompile, or a changed committed revision), never instantly. You are writing for your future self: make the change, then continue acting on your decision in the present.

There are three ways to change memory:

- **The `memory` tool (shorthand).** Use it for small, targeted edits. It commits automatically with the correct agent authorship.
- **The `memory_apply_patch` tool.** Use it for larger patches across one or more files. It validates the active memory format and commits automatically.
- **Direct file edits (full control).** For structural changes, edit the projected files directly, validate the root indexes and frontmatter, then commit.

`$AGENT_NAME` is normally populated when the runtime knows the current agent name, but direct shell environments can still miss it. Use a non-empty author name fallback when committing directly.

```bash
cd "$MEMORY_DIR"

# See what changed
git status

# Commit your changes
git add <specific files>
author_name="${AGENT_NAME:-$AGENT_ID}"
git commit --author="$author_name <$AGENT_ID@letta.com>" -m "<type>: <what changed>"
```

Your context is git-tracked, so you can always inspect or revert past changes:

```bash
git -C "$MEMORY_DIR" log --oneline
```
The system reminds you when memory has uncommitted changes. Commit when convenient.
