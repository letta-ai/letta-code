Watch a public http(s) URL with `url`. A `url` monitor runs in Letta Cloud, keeps running when this sandbox or machine stops, and notifies you only when the HTTP status or body changes. It is available only when connected to Letta Cloud.

For an authenticated API, pass `headers` that reference agent secrets as `$NAME`, the same as in shell commands: `{"PRIVATE-TOKEN": "$GITLAB_TOKEN"}`. Cloud fills them in on every poll, so the token is never written into the monitor. Use `select` to compare one JSON field instead of the whole body, and `match` to be notified when it reaches a value, with `stop_on_match` to finish after that. For a CI pipeline: `select: "0.status"`, `match: {"equals": ["success", "failed", "canceled"]}`, `stop_on_match: true`. The first response is checked against `match` too, so a pipeline that already finished notifies right away. Match every terminal state, not just success.

Returns a task id immediately. Keep working; do not poll or sleep. Stop it with TaskStop.
