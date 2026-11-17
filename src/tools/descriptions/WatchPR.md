Watch one open github.com PR until merge, close, TaskStop or timeout; local watches also stop at session end.

In managed Cloud, WatchPR stops after {{MONITOR_MAX_TIMEOUT}} (the monitor cap) and sends a timeout notification. Call WatchPR again to re-arm it if you still need to watch. For much longer waits, use Wake or cron (which does not keep the sandbox running between turns) and combine it with shorter watches. Outside managed Cloud, local watches have no duration limit.

Use WatchPR instead of writing a Monitor or shell polling loop when you need ongoing notifications about a PR: checks, comments, reviews, review threads, pushes, conflicts, merge state, merge, and close. Start at most one watch per PR.

The initial result includes current blockers. Local watches also compare a saved snapshot up to seven days old. The first snapshot is never merge-ready: readiness requires a second consecutive read on the same head, so `awaiting a second same-head readiness read` is expected at startup. Later changes arrive as task notifications in this conversation. Cloud watches run remotely when enabled; others poll locally via the Cloud GitHub integration or `gh`. It keeps watching green PRs for feedback, conflicts and pushes. Green checks are not the same as a mergeable PR, so report the PR as ready, green, or mergeable only once the watcher reports it merge-ready.

Pass a URL ending at the PR number, such as `https://github.com/owner/repo/pull/123`. Remove `/files`, `/commits`, `/checks`, and other suffixes. The watcher is read-only and errors if the PR is already merged or closed.

Use `notify_on` to limit PR notifications (for example `["merged", "closed", "conflict"]` or `["checks_done"]`); watcher errors still report. For several PRs, start one watch per URL. Workflow run URLs (`https://github.com/owner/repo/actions/runs/123`) report status changes and completion with conclusion and failed jobs/steps, including runs without a PR. Reruns remain a separate action.

Pass `resume` with a local paused monitor id to restart it; a cloud id retrieves its status. Cloud watches continue between sessions.
