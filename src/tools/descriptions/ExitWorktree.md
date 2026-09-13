# ExitWorktree

Leave the git worktree this conversation is working in and return to the primary checkout, optionally deleting the worktree and its branch.

Use this tool only when the user asks to exit, leave, or go back from a worktree, or asks to clean one up when the work is done or abandoned. Do NOT call it proactively — finishing a task is not by itself a reason to leave the worktree.

## Scope

Applies to the worktree the conversation is currently in, when that worktree lives under `.letta/worktrees/` — the location EnterWorktree creates and enters. It does not matter whether this conversation created it.

If the current working directory is not a managed worktree, this tool is a **no-op**: it reports that there is nothing to exit and changes nothing on disk.

## Parameters

- `action` (required):
  - `"keep"` — leave the worktree directory and branch intact. Use when the user may come back to the work, or when it holds changes worth preserving.
  - `"remove"` — delete the worktree directory and its branch. Use for a clean exit when the work is merged, done, or abandoned.
- `discard_changes` (optional, default `false`): only meaningful with `action: "remove"`. If the worktree has uncommitted changes or commits that are not in the base ref, removal is refused unless this is `true`. When the tool reports refused work, surface it to the user and get confirmation before re-running with `discard_changes: true`.

## Behavior

- Switches the conversation's working directory back to the primary checkout **before** touching the worktree, so removing it cannot strand the session (or a persistent shell) in a deleted directory.
- Releases this conversation's cross-agent worktree lock, so another agent can take the worktree over. A lock held by a different conversation is left alone.
- With `action: "remove"`, deletes the worktree and then its branch. If the branch cannot be deleted safely, the worktree removal still succeeds and the leftover branch is reported.
- Returns to the primary checkout, not to whatever directory you happened to be in before entering — the primary checkout is the reliable destination across restarts and across worktree-to-worktree switches.

## After success

- Confirm the working directory with `git status` before editing further.
- If a branch was kept behind, tell the user its name so the work is not lost.
