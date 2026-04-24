# CreateWorktree

Create a fresh isolated git worktree for this conversation.

Use this tool when starting a new feature, bug fix, refactor, or other file-editing task where the user or other agents may be working in the same repository. Prefer this tool over manually running `git worktree add` with Bash because it creates the worktree in Letta Code's canonical location, bases it on the latest default branch, and updates only this conversation's working directory.

Do not use this tool for read-only tasks, code review, answering questions, continuing work already in the correct checkout, or when the user explicitly asks to work in the current checkout.

Behavior:
- Verifies the current cwd is inside a git repository.
- Creates the worktree under `.letta/worktrees/` for the repository.
- Creates a new branch from the default base ref unless `branch_name` or `base_ref` is provided.
- By default, switches this conversation's cwd to the new worktree.
- Does not copy uncommitted changes from the current checkout.
- Does not install dependencies or run project setup commands.

After success:
- Continue using the returned worktree path as the current workspace.
- If a `working-in-parallel` skill is available, invoke it before editing.
- Inspect the project and install dependencies if needed, for example `bun install`, `npm install`, or another repo-specific setup command.
