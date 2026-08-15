# TaskOutput

- Retrieves output from a running or completed task (background shell, monitor, agent, or remote session)
- Required: `task_id` (the task to query), `block` (whether to wait for completion), `timeout` (max wait time in ms; capped at 600000)
- Returns the task output along with status information
- Use `block=true` to wait until the task finishes (or `timeout` elapses)
- Use `block=false` for an immediate, non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, monitors, async agents, and remote sessions
- Once a task completes you already have its output file path — it was returned when the task started, and repeated in the `<task-notification>` you receive on completion. For the full transcript at that point, prefer `Read` on that path over calling this tool again; reserve `TaskOutput` for blocking/waiting on a task that hasn't finished yet or for a quick status check.
