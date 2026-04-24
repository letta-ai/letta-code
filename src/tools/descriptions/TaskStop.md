# TaskStop

- Stops a running background task by its ID
- Required: `task_id` (the task to terminate; the legacy `shell_id` alias has been removed — bash background shells share the same ID space as other tasks)
- Returns `{ killed: boolean }` indicating whether the task was actively running and got terminated
- Use this tool when you need to terminate a long-running task
