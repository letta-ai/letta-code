Watch a GitHub pull request until it merges, closes, or is stopped with TaskStop.

Use WatchPR instead of writing a Monitor or shell polling loop for a PR. It takes an initial fail-closed snapshot, then keeps watching after CI finishes for:

- current-head check failures, recoveries, retries, and completion;
- issue comments, submitted reviews, and inline review comments;
- unresolved, resolved, reopened, and outdated review threads;
- head changes, draft changes, merge conflicts, and GitHub merge-state changes;
- merge-ready regressions, merge-ready transitions, watcher errors, merge, and close.

The initial tool result includes blockers that already exist when the watch starts. Later changes arrive as task notifications in this conversation. The watcher uses the locally authenticated `gh` CLI, polls every 30 seconds, and is session-persistent. It deliberately does not stop when checks become green because reviews, comments, conflicts, and new pushes can still arrive.

Pass the full GitHub pull request URL. The watcher is read-only and supports github.com pull requests.
