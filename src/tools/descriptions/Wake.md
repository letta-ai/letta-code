Schedule a future turn for the current conversation. Wake is the durable, time-based counterpart to Monitor: use Monitor when ongoing work can emit an event, and Wake when you need to act at a future time even if nothing emits one.

Wake is always self-bound. It cannot target another agent, conversation, or computer.

- `create`: provide `name`, `prompt`, and exactly one of `after_seconds`, `scheduled_at`, or `cron`.
- `list`: list active and paused wakes for this conversation.
- `cancel`: provide the `id` returned by create or list.

Use `after_seconds` for ordinary follow-ups such as checking again in five minutes. `scheduled_at` must be RFC 3339 with `Z` or an explicit UTC offset. `cron` is a recurring five-field UTC expression and cannot run more often than hourly.

For calendar requests such as “tomorrow at 9am,” resolve the date in the user's timezone and pass `scheduled_at` with an explicit offset. Infer a reasonable timezone from available context instead of asking a redundant follow-up. State the timezone you used in the confirmation (for example, “Scheduled for 9:00 AM PT”) so the user can correct the assumption.

Wakes created in a managed Cloud sandbox survive sandbox shutdown. Wakes created on a user-managed computer or self-hosted runtime use its local scheduler and only fire while a listener is active. List and cancel include both local and Cloud wakes already bound to this conversation, so older wakes remain manageable. The create result warns when no listener currently owns local schedules.

For advanced scheduling, load the `scheduling-tasks` skill and use `letta cron`. The CLI can target fresh, default, or other conversations and, from managed Cloud, connected computers; it can also inspect run history and manage schedules outside the current conversation.
