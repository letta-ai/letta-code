Start a background monitor that streams events from a public http(s) URL. Each change to the HTTP status or body is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Use Monitor when you need one notification per occurrence: until the timeout ("every time the status changes"), or until a known end ("each CI step result, stop when the run completes": use `match` with `stop_on_match: true`). For a single notification ("tell me when the server is ready"), use `match` with `stop_on_match: true`.

For open github.com pull requests, use WatchPR instead. It covers the whole PR surface and keeps watching after CI finishes. Use Monitor only when WatchPR does not apply.

- A `url` monitor runs in Letta Cloud, keeps running when this sandbox or machine stops, and is available only when connected to Letta Cloud.
- Cloud polls the URL with GET every 60s by default. Set `interval_seconds` to 60 or more. The first response is the baseline; by default, it notifies only when the HTTP status or body changes.
- Use `select` to compare one JSON field instead of the whole body, and `match` to be notified when it reaches a value, with `stop_on_match` to finish after that. The first response is checked against `match` too, so a pipeline that already finished notifies right away. A value that keeps matching does not notify again.
- Every event is a conversation message, so filter to the events you'd act on.

**Coverage — silence is not success.** When watching a job for an outcome, your filter must match every terminal state, not just the happy path. A monitor that matches only the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Match failures too, e.g. `select: "0.status"`, `match: {"equals": ["success", "failed", "canceled"]}`, `stop_on_match: true`.

A match ends the watch when `stop_on_match` is true. Timeout → killed. Set `timeout_ms` for longer watches; the default is 24 hours and the maximum is 7 days. Call Monitor again to re-arm it if you still need to watch. For much longer Cloud waits, schedule a Wake or cron (which does not keep the sandbox running between turns) and combine it with shorter monitors. Use TaskStop to cancel early.

When someone is waiting on the result, schedule a Wake or cron to check the real state, so a queued, hung, or dead watch can't leave them waiting in silence.

For an authenticated API, pass `headers` that reference agent secrets as `$NAME`, the same as in shell commands: `{"PRIVATE-TOKEN": "$GITLAB_TOKEN"}`. Cloud fills them in on every poll, so the token is never written into the monitor.
