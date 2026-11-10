Executes a shell command and returns its output.

- Each Bash call starts from the conversation's current working directory. A `cd` affects only that command and does not change the directory used by later tool calls. To change the working directory for later tool calls, use `SetWorkingDirectory`. For a one-off command elsewhere, use an absolute path or an option such as `git -C /path/to/repo status`.
- IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed. Use Read, Edit and Write for file operations instead. Quote paths that contain spaces.
- Command output is displayed to you, not reliably to the user.
- `timeout` is in milliseconds. Without it, commands run until they exit; foreground timeouts max out at 600000.
- If the output exceeds 30000 characters, you receive only the first 2000 characters plus the path of a file containing the full output. A failed command whose output exceeds 10000 characters returns a head-and-tail excerpt plus that file path. Read or search that file when you need the rest instead of re-running the command.
- Commands still running after a brief wait continue in the background automatically: you receive a task ID and one completion notification. Do not predict command duration, set `run_in_background` merely because a command may be slow, or poll for completion. Set `run_in_background` only when you want the task ID immediately; no `&` needed.
- Foreground `sleep` is blocked. To be told when a job finishes, start it with `run_in_background` and end your turn; its completion notification arrives on its own, so do not poll or start a separate waiter. For one notification per event, use Monitor. If you genuinely need to wait until a condition holds, the command must be guaranteed to exit, even if the condition never comes true.
- Run independent commands as parallel tool calls; chain dependent ones with `&&`.

# Git
- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.
- Use the `gh` CLI for GitHub operations (PRs, issues, API).
- GitHub notifies the owner of any `@name` written in a PR, issue, or comment. Write a bare `@name` only for a real login you mean to notify. Put roles, placeholders, and code (`@human`, `@reviewer`, `@types/node`) in backticks or drop the `@`.
- Commit or push only when the user asks. Do not amend, skip hooks, force-push, or run other destructive git commands unless the user asks; if a pre-commit hook fails, fix the issue and create a new commit.
- Pass commit messages and PR bodies as single-quoted strings with embedded newlines. Do not wrap them in `$(...)` or backticks. End commit messages with:
{{COMMIT_TRAILER}}
<example>
git commit -m 'Commit message here.

{{COMMIT_TRAILER}}'
</example>
- Passing `gh pr checks` does not mean GitHub will merge the PR — unresolved review threads and still-pending required checks leave the merge state BLOCKED. If WatchPR is available and you will follow the PR toward merge, start it on the PR URL, and call the PR ready, green, or mergeable only once WatchPR reports it merge-ready.
