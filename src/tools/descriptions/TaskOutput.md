# TaskOutput

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Required: `task_id` (the task to query), `block` (whether to wait for completion), `timeout` (max wait time in ms; capped at 600000)
- Returns the task output along with status information
- Use `block=true` to wait until the task finishes (or `timeout` elapses)
- Use `block=false` for an immediate, non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions
