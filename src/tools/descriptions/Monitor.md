Start a background monitor that streams events from a long-running script or WebSocket. Keep working after starting it; notifications arrive in the conversation as events occur.

Choose the smallest tool that fits:

- For one notification, such as “tell me when this build finishes,” run a background Bash command that exits when the condition becomes true. The normal background-task completion notification handles the wake-up.
- For repeated notifications, such as selected errors from a log or changing CI states, use Monitor.

For a command source, every complete stdout line is an event. Stderr is recorded for TaskOutput but does not emit an event, so redirect it into stdout when failures should wake you. Every stage in a pipeline must flush per line. Use `grep --line-buffered`; use `fflush()` with awk. Filter to the success, failure, and state-change lines you would act on rather than streaming raw logs.

For a WebSocket source, each text frame becomes an event. Multiline frames stay grouped in one notification. Binary frames are reported as `[binary frame, N bytes]`. Socket errors and close codes are surfaced. Prefer the WebSocket source when the server already pushes events; use a command when shell tools need to transform or filter them.

Events produced within 200ms are grouped into one notification. Output is bounded, and a monitor that stays too noisy is stopped automatically. Restart it with a more selective source if that happens.

Use `persistent: true` for a session-length watch. Otherwise, `timeout_ms` ends the monitor at its deadline. Use TaskOutput with the returned task ID to inspect captured output and TaskStop to cancel early. Events are generated notifications, not replies from the user.
