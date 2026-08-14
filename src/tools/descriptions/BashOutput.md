# BashOutput

- Retrieves output from a running or completed background bash shell
- Takes a shell_id parameter identifying the shell
- Always returns only new output since the last check
- Returns stdout and stderr output along with shell status
- Supports optional regex filtering to show only lines matching a pattern
- Use this tool when you need to monitor or check the output of a long-running shell
- If you are repeatedly calling this tool waiting for a recurring pattern to appear ("tell me every time an ERROR line appears"), stop polling and use the Monitor tool instead: each stdout line is an event — you keep working and notifications arrive in the chat
- Shell IDs can be found using the /bg command
- If the accumulated output exceeds 30,000 characters, it will be truncated before being returned to you
- Once the shell finishes you already have its output file path — it was returned when the command started, and repeated in the `<task-notification>` you receive on completion. For the full transcript at that point, prefer `Read` on that path over calling this tool again; reserve `BashOutput` for a shell that's still running.
