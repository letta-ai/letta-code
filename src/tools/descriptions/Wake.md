Schedule a future turn for the current conversation. Wake is the durable, time-based counterpart to Monitor: use Monitor when ongoing work can emit an event, and Wake when you need to act at a future time even if nothing emits one.

Wake is always self-bound. It cannot target another agent, conversation, or computer.

- `create`: provide `name`, `prompt`, and exactly one of `after_seconds`, `scheduled_at`, or `cron`.
- `list`: list active and paused wakes for this conversation.
- `cancel`: provide the `id` returned by create or list.

Write `prompt` as a note to your future self, not a script: what you are waiting on, what you planned and why, and what to check before acting. When the wake fires, the situation or people's wishes may have changed since you wrote it.

Use `after_seconds` for ordinary follow-ups. `scheduled_at` must be RFC 3339 with `Z` or an explicit UTC offset. `cron` is a recurring five-field UTC expression and cannot run more often than hourly. For calendar requests such as "tomorrow at 9am," resolve the time in the user's timezone (inferred from context), pass an explicit offset, and state the timezone you used.

Wakes created in a managed Cloud sandbox or a registered Cloud API listener are durable Cloud schedules; listener wakes target the current computer and fail if it is offline when they fire. Cloud API runtimes without a registered computer must register it before scheduling; Cloud errors never create a local wake. Interactive TUI and Desktop-owned sessions, the local backend, and self-hosted servers without schedule routes use local wakes, which fire only while a listener is active, and the create result warns when none is. For schedules targeting other conversations or computers, load the `scheduling-tasks` skill.
