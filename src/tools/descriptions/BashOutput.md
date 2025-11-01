# BashOutput

- Retrieves output from a running or completed background bash shell
- Takes a bash_id parameter identifying the shell
- Always returns only new output since the last check
- Returns stdout and stderr output along with shell status
- Supports optional regex filtering to show only lines matching a pattern
- Use this tool when you need to monitor or check the output of a long-running shell
- Shell IDs can be found using the /bashes command
- If the accumulated output exceeds 30,000 characters, it will be truncated before being returned to you