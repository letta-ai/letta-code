Leave the git worktree this conversation is working in and return to the primary checkout, optionally deleting the worktree and its branch.

Use this tool only when the user asks to exit, leave, or go back from a worktree, or asks to clean one up when the work is done or abandoned. Do NOT call it proactively — finishing a task is not by itself a reason to leave the worktree.

It applies to the current worktree when it lives under `.letta/worktrees/`, whoever created it. Anywhere else it is a no-op.

- `action: "keep"` leaves the worktree directory and branch intact; use it when the user may come back or the work is worth preserving. `action: "remove"` deletes the worktree and its branch.
- `discard_changes` (default `false`): removal is refused when the worktree has uncommitted changes or commits not in the base ref. Surface refused work to the user and get confirmation before re-running with `discard_changes: true`.
- The working directory returns to the primary checkout, and this conversation's worktree lock is released.

After success, confirm the working directory with `git status` before editing further. If a branch was kept behind, tell the user its name so the work is not lost.
