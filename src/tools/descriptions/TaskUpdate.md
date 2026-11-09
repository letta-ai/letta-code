Update a task in the task list. Read its latest state with `TaskGet` before updating.

- Status moves `pending` → `in_progress` → `completed`; `deleted` permanently removes a task.
- Mark a task completed only when it is fully done. If tests are failing, the implementation is partial, or you hit unresolved errors or blockers, keep it `in_progress` and create a new task describing what needs to be resolved.
- Always mark your assigned tasks resolved when you finish them, then call TaskList to find your next task.
- You can also change `subject`, `description`, `activeForm`, `owner`, merge `metadata` keys (null deletes a key), and add dependencies with `addBlocks` / `addBlockedBy`.

Example: `{"taskId": "1", "status": "in_progress"}`
