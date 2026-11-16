Schedule a future turn for the current conversation. Use Monitor whenever you can check for the condition you are waiting on, with `backup_after_seconds` as its durable fallback. Use Wake for time-based follow-ups or waits longer than about an hour.

Wake is always self-bound. It cannot target another agent, conversation, or computer.

- `create`: provide `name`, `prompt`, and exactly one of `after_seconds`, `scheduled_at`, or `cron`.
- `list`: list active and paused wakes for this conversation.
- `cancel`: provide the `id` returned by create or list.

Write `prompt` as a note to your future self, not a script: what you are waiting on, what you planned and why, and what to check before acting. When the wake fires, the situation or people's wishes may have changed since you wrote it.

Use `after_seconds` for follow-ups after a delay. `scheduled_at` must be RFC 3339 with `Z` or an explicit UTC offset. `cron` is a recurring five-field UTC expression and cannot run more often than hourly. For calendar requests such as "tomorrow at 9am," resolve the time in the user's timezone (inferred from context), pass an explicit offset, and state the timezone you used.

For schedules targeting other conversations or computers, load the `scheduling-tasks` skill.
