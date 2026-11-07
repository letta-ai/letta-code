Runs a command in a PTY, returning output or a session ID for ongoing interaction.

For ordinary one-shot commands, omit `yield_time_ms` and let the default wait for completion; set `yield_time_ms` only when intentionally returning early from a long-running or interactive command.

If a command is still running when this tool yields, you will receive a notification when it completes. Do not poll the session just to check whether it has finished. Use `write_stdin` only when you need to send input, interrupt the process, or obtain output before you can continue.

Git commits: commit only when the user asks. Pass the message as a single-quoted string with embedded newlines; do not wrap it in `$(...)` or backticks. End commit messages with:
{{COMMIT_TRAILER}}
<example>
git commit -m 'Commit message here.

{{COMMIT_TRAILER}}'
</example>
