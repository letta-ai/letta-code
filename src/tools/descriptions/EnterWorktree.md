Create a fresh isolated git worktree for this conversation, or switch this conversation into an existing one.

Use this tool when starting a new feature, bug fix, refactor, or other file-editing task where isolated branch work is useful, especially if the user or other agents may be working in the same repository. Prefer worktrees by default unless the user explicitly asks to work in the current checkout or says they do not want worktrees.

Do not use this tool for read-only tasks, code review, answering questions, continuing work already in the correct checkout, or when the user explicitly asks not to use worktrees. Prefer it over running `git worktree add` yourself: it creates the worktree under `.letta/worktrees/`, bases it on the latest default branch, and switches this conversation's working directory.

- Pass `name` (and optionally `branch_name`/`base_ref`) to create a new worktree, or `path` to switch into an existing one under `.letta/worktrees/`, e.g. to resume work another conversation started. `path` is mutually exclusive with `name`, `branch_name` and `base_ref`.
- If the current cwd is not inside the target git repository, pass `repo_path` instead of falling back to manual `git worktree` commands.
- Uncommitted changes in the current checkout are not copied.
- Creation fails when repository config (conditional includes, Git LFS transfer settings) prevents checkout filters and hooks from being disabled safely.
- Switching into a worktree takes an advisory lock for this conversation. Entering one another active agent holds fails; if that agent is no longer active, retry with `force: true`.
- Dependencies are not shared by default; install them with the repo's package manager. `symlink_dependencies: true` symlinks `node_modules` and similar from the primary checkout instead — use it only when the worktree will not change packages, and then do NOT run an install, because it writes through to the primary checkout.

After success:
- Continue using the returned worktree path as the current workspace, and confirm with `git status` before editing.
- Root `AGENTS.md` instructions are loaded into the successful tool result when present. Follow them before running setup, build, or validation commands; read README or other setup docs for anything they do not cover.
