Watch one open github.com pull request until it merges, closes, is stopped with TaskStop, or the session ends.

Use WatchPR instead of writing a Monitor or shell polling loop when you need ongoing notifications about a PR. Start at most one watch per PR. It reports:

- current-head check failures, recoveries, retries, and completion;
- new or edited PR comments, submitted reviews, and inline review comments;
- unresolved review-thread blockers and resolved, reopened, or outdated transitions;
- head changes, draft changes, merge conflicts, and GitHub merge-state changes;
- merge-ready regressions, merge-ready transitions, watcher errors, merge, and close.

The initial result includes current blockers. The first snapshot is never merge-ready: readiness requires a second consecutive read on the same head, so `awaiting a second same-head readiness read` is expected at startup. Later changes arrive as task notifications in this conversation. The watcher uses the locally authenticated `gh` CLI, polls every 30 seconds while GitHub is reachable, backs off after refresh errors, and keeps watching after checks become green because reviews, comments, conflicts, and new pushes can still arrive. Green checks are not the same as a mergeable PR, so report the PR as ready, green, or mergeable only once the watcher reports it merge-ready.

Pass a URL ending at the PR number, such as `https://github.com/owner/repo/pull/123`. Remove `/files`, `/commits`, `/checks`, and other suffixes. The watcher is read-only and errors if the PR is already merged or closed.
