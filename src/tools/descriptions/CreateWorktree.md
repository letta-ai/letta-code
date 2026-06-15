# CreateWorktree

Create a fresh isolated git worktree for this conversation.

Use this tool when starting a new feature, bug fix, refactor, or other file-editing task where isolated branch work is useful, especially if the user or other agents may be working in the same repository. Prefer worktrees by default unless the user explicitly asks to work in the current checkout or says they do not want worktrees.

Prefer this tool over manually running `git worktree add` with Bash because it creates the worktree in Letta Code's canonical location, bases it on the latest default branch, and updates this conversation/session's working directory when supported.

Do not use this tool for read-only tasks, code review, answering questions, continuing work already in the correct checkout, or when the user explicitly asks not to use worktrees.

Behavior:
- Uses the current cwd as the target git repository by default, or `repo_path` when provided.
- If the current cwd is not inside a git repository, pass `repo_path` instead of falling back to manual `git worktree` commands.
- Creates the worktree under `.letta/worktrees/` for the target repository.
- Creates a new branch from the default base ref unless `branch_name` or `base_ref` is provided.
- By default, switches the active conversation/session cwd to the new worktree.
- Does not copy uncommitted changes from the current checkout.
- Does not install dependencies or run project setup commands.

After success:
- Continue using the returned worktree path as the current workspace.
- Confirm you are in the new worktree with `git status` before editing.
- Read README, AGENTS.md, or other project setup docs before running commands.
- If this repo needs per-worktree dependency setup, install dependencies with the project's package manager. Check the repo first: if it uses Bun, run `bun install` instead of `npm install`; if it uses pnpm, yarn, or npm, use that package manager instead.
- Verify pre-commit hooks are installed and active before relying on commits. Check `git config --get core.hooksPath` and confirm the hook path exists; if hooks are missing or stale, run the repo's hook setup command (often dependency install / Husky prepare) before committing.
