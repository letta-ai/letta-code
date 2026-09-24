Schedule a future turn for the current conversation. Wake is the durable, time-based counterpart to Monitor: use Monitor when ongoing work can emit an event, and Wake when you need to act at a future time even if nothing emits one.

Wake is always self-bound. It cannot target another agent, conversation, computer, or runner.

- `create`: provide `name`, `prompt`, and exactly one of `after_seconds`, `scheduled_at`, or `cron`.
- `list`: list active and paused wakes for this conversation.
- `cancel`: provide the `id` returned by create or list.

Use `after_seconds` for ordinary follow-ups such as checking again in five minutes. `scheduled_at` must be RFC 3339 with `Z` or an explicit UTC offset. `cron` is a recurring five-field UTC expression and cannot run more often than hourly.

Cloud wakes survive local process, computer, and sandbox shutdown. Local or self-hosted agents use the local scheduler and only fire while a listener is active. The create result warns when no listener currently owns local schedules.

For advanced scheduling, load the `scheduling-tasks` skill and use `letta cron`. The CLI can target fresh, default, or other conversations; select local or Cloud runners and computers; inspect run history; and manage schedules outside the current conversation.
