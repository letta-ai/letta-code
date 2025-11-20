# shell

Runs a shell command represented as an array of arguments and returns its output.

- **command**: Required array of strings to execute, typically starting with the shell (for example `["bash", "-lc", "npm test"]`).
- **workdir**: Optional working directory to run the command in; prefer using this instead of `cd`.
- **timeout_ms**: Optional timeout in milliseconds (defaults to 120000ms / 2 minutes).
- **with_escalated_permissions / justification**: Accepted for compatibility with Codex; currently treated as hints only and do not bypass local sandboxing.









