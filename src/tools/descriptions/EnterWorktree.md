# EnterWorktree

Create a fresh isolated git worktree for this conversation, or switch this conversation into an existing one.

Use this tool when starting a new feature, bug fix, refactor, or other file-editing task where isolated branch work is useful, especially if the user or other agents may be working in the same repository. Prefer worktrees by default unless the user explicitly asks to work in the current checkout or says they do not want worktrees.

Pass `name` (and optionally `branch_name`/`base_ref`) to create a new worktree. Pass `path` instead to switch into an existing worktree that was created under `.letta/worktrees/` — for example to resume work or hand off to a worktree another conversation started.

Prefer this tool over manually running `git worktree add` with Bash because it creates the worktree in Letta Code's canonical location, bases it on the latest default branch, and updates this conversation/session's working directory when supported.

Do not use this tool for read-only tasks, code review, answering questions, continuing work already in the correct checkout, or when the user explicitly asks not to use worktrees.

Behavior:
- Uses the current cwd as the target git repository by default, or `repo_path` when provided.
- If the current cwd is not inside a git repository, pass `repo_path` instead of falling back to manual `git worktree` commands.
- Creates the worktree under `.letta/worktrees/` for the target repository.
- Creates a new branch from the default base ref (with `--no-track`, so it does not adopt the base as an upstream) unless `branch_name` or `base_ref` is provided.
- By default, switches the active conversation/session cwd to the new worktree.
- Does not copy uncommitted changes from the current checkout.
- Automatically provisions the new worktree so it is usable without a manual setup pass:
  - Wires git hooks: if `core.hooksPath` is relative (e.g. husky's `.husky/_`, whose contents are gitignored and absent in a fresh worktree), it symlinks the populated hooks directory from the primary checkout so pre-commit hooks run.
  - Copies `.letta/settings.local.json` into the worktree when present.
  - Copies gitignored files/directories listed in a repo-root `.worktreeinclude` file (and in the `worktree.include` project setting) — use this for config like `.env`.
- Dependencies are NOT shared by default: the worktree starts isolated, so install them with the repo's package manager if needed (modern managers like Bun/pnpm install quickly from a shared cache). Opt into sharing with `symlink_dependencies: true`, which symlinks heavy gitignored dependency directories (default: `node_modules`) from the primary checkout to avoid reinstalling — but only when the worktree will NOT change packages, because a package install into a symlinked `node_modules` writes through to the primary checkout's dependencies.
- Provisioning is configurable project-wide via the `worktree` block in `.letta/settings.json` (`symlinkDirectories`, `copyLocalSettings`, `linkHooks`, `include`) and is best-effort: it reports what was done/skipped in the result and never aborts worktree creation.

Entering an existing worktree (`path`):
- Switches the conversation/session cwd into the worktree at `path` without creating or re-provisioning anything.
- `path` must be a registered, non-prunable linked worktree of this repository, living under `.letta/worktrees/`. The main working tree and unmanaged worktrees are rejected.
- Mutually exclusive with `name`, `branch_name`, and `base_ref`.

Cross-agent lock:
- Switching into a worktree (whether by creating it or entering one) takes an advisory lock recording this conversation as its current owner, so two agents do not edit the same worktree concurrently.
- Entering a worktree another active agent already holds fails with an error. If that agent is no longer active, retry with `force: true` to take over the lock. Locks left by a crashed/exited process are detected and reclaimed automatically.
- The lock is released when this conversation switches into a different worktree, and never blocks re-entering a worktree you already hold.

After success:
- Continue using the returned worktree path as the current workspace.
- Confirm you are in the new worktree with `git status` before editing.
- Read README, AGENTS.md, or other project setup docs before running commands.
- Dependencies are not shared by default. If the project has dependencies, install them in the worktree with the repo's package manager — check the repo first: if it uses Bun, run `bun install`; if pnpm, yarn, or npm, use that manager instead. (If you created the worktree with `symlink_dependencies: true`, they are already present via a symlink to the primary checkout — do NOT run an install, as it would mutate the primary checkout's `node_modules`.)
