# TaskOutput

- Retrieves output from a running or completed task (background shell, monitor, agent, or remote session)
- Required: `task_id` (the task to query), `block` (whether to wait for completion), `timeout` (max wait time in ms; capped at 600000)
- Returns the task output along with status information
- Use `block=true` to wait until the task finishes (or `timeout` elapses)
- Use `block=false` for an immediate, non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, monitors, async agents, and remote sessions
- Memory workers are silent: do not wait or poll for incidental memory upkeep during another task. If memory becomes the main task, you may wait for an existing worker to finish before editing the same checkout.
- The task's output file path is returned when it starts. Tasks with completion notifications repeat it in `<task-notification>`; silent memory workers do not send those notifications. For the full transcript of a completed task, prefer `Read` on that path over calling this tool again; reserve `TaskOutput` for blocking/waiting on a task that hasn't finished yet or for a quick status check.
