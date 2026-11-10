Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Use Monitor when you need one notification per occurrence: indefinitely ("every time an ERROR line appears": `tail -f`, `inotifywait -m`, `while true`), or until a known end ("each CI step result, stop when the run completes": a command that emits lines and then exits). For a single notification ("tell me when the build finishes"), start the job itself with `run_in_background` in your shell tool and end your turn; its completion notification arrives on its own. If you genuinely need to wait until a condition holds, the command must be guaranteed to exit, even if the condition never comes true: an unbounded wait stays armed until timeout, and `tail -f log | grep -m 1 ...` can hang the same way.

For open github.com pull requests, use WatchPR instead. It covers the whole PR surface and keeps watching after CI finishes. Use Monitor only when WatchPR does not apply.

- Every pipe stage must flush per line or matches sit in its buffer unseen: `grep` needs `--line-buffered`, `awk` needs `fflush()`. `| head -N` delivers nothing until N matches accumulate.
- In poll loops, handle transient failures (`curl ... || true`). Poll remote APIs every 30s+, local checks every 0.5–1s.
- Only stdout is the event stream. Stderr goes to the output file named in the result, without notifications; merge it with `2>&1` for commands you run directly so failures reach your filter.
- Every stdout line is a conversation message, so filter to the lines you'd act on. Lines within 200ms are batched into one notification. Monitors that produce too many events are stopped automatically; restart with a tighter filter.

**Coverage — silence is not success.** When watching a job for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Match failures too, e.g. `grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|Killed|OOM"`, and in poll loops emit on every terminal status (`succeeded|failed|cancelled|timeout`).

Exit ends the watch (exit code is reported). Timeout → killed. Set `persistent: true` for session-length watches (log tails, long-lived event streams). In managed Cloud sandboxes, every monitor, including persistent ones, stops after {{MONITOR_MAX_TIMEOUT}} (this sandbox's monitor cap); elsewhere persistent monitors run until TaskStop or session end. Call Monitor again to re-arm it if you still need to watch. For much longer Cloud waits, schedule a Wake or cron (which does not keep the sandbox running between turns) and combine it with shorter monitors. Use TaskStop to cancel early.

When someone is waiting on the result, set `backup_after_seconds` (e.g. 900). If the monitor goes that long without an event, a durable Wake brings you back to check the real state, so a queued, hung, or dead watch can't leave them waiting in silence.

Instead of `command`, `ws` streams each WebSocket text frame as an event (prefer it over `websocat`), and `script` runs a JavaScript watch loop with CodeMode's globals plus `emit(text)` and `sleep(ms)`; `decide()` spends money on every call, so call it only when an observed change needs judgment.
