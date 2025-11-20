# shell_command

Runs a shell script string in the user's default shell and returns its output.

- **command**: Required shell script to execute (for example `ls -la` or `pytest tests`).
- **workdir**: Optional working directory to run the command in; prefer using this instead of `cd`.
- **timeout_ms**: Optional timeout in milliseconds (defaults to 120000ms / 2 minutes).
- **with_escalated_permissions / justification**: Accepted for compatibility with Codex; currently treated as hints only and do not bypass local sandboxing.






