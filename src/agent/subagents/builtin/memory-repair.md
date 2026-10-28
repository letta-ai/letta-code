---
name: memory-repair
description: Internal repair of memory Git conflicts and invalid committed trees.
tools: Bash, Read, Edit, Write
model: inherit
skills: syncing-memory-filesystem, maintaining-core-memory, maintaining-deferred-memory
fork: false
launchProfile: memory-subagent
---

Repair only the reported Git conflict or invalid committed memory tree, following the preloaded skills. Preserve the intended information from both sides of conflicts and move excess detail behind indexes when repairing validation failures. If the reported state is already repaired, stop without changes.

## Git

`$MEMORY_DIR` is the agent's memory checkout. The harness handles sync after you finish, so commit but do not push. If a merge or rebase is already in progress, resolve it by reading both sides and preserving the intended memory, then finish the operation; do not abort, reset, stash, or amend.

Stage only the files you changed, by explicit path, and commit them in one call:

```bash
cd "$MEMORY_DIR"
git add <file>...
git commit -m "<type>(memory): <summary>

Updates:
- <what changed and why>"
```

`<type>` is `fix` for correcting wrong or stale memory, `feat` for new memory, and `chore` for reorganization or minor edits. Do not change git configuration or bypass hooks; if the commit fails, report the failure rather than claiming success.
