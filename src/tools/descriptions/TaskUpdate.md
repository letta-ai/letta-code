# TaskUpdate

Partially update a single task. Only the fields you pass will change; everything else stays intact.

## Status transitions

Use the `status` field to move a task through its lifecycle:

- `pending` — not started
- `in_progress` — actively being worked on (keep only ONE task in this state at a time)
- `completed` — finished
- `deleted` — soft-delete; excluded from `TaskList` but still fetchable via `TaskGet`

Mark a task `completed` **only** when it's fully done — tests pass, implementation is complete, no unresolved errors. If blocked, leave it `in_progress` and create a new task for the blocker (then wire it up via `addBlockedBy`).

## Editable fields

- `subject`, `description`, `activeForm` — full replacements
- `owner` — assign a string owner (free-form)
- `addBlocks` — append task IDs that **this task blocks** (they can't start until this one finishes)
- `addBlockedBy` — append task IDs that **block this task** (they must finish first)
- `metadata` — merged into existing metadata (existing keys preserved; matching keys overwritten)

## Best practices

- Update status in real-time as you work — don't batch status changes at the end
- Exactly ONE task should be `in_progress` at any given time
- Only use `status: "deleted"` when a task is no longer relevant; prefer completion when possible
- When adding dependencies, call `TaskList` first to verify the referenced IDs exist

## Example

```
TaskUpdate({
  taskId: "task_3",
  status: "in_progress",
  owner: "agent-abc123"
})

TaskUpdate({
  taskId: "task_3",
  addBlockedBy: ["task_1", "task_2"]
})

TaskUpdate({
  taskId: "task_3",
  status: "completed"
})
```

Returns the updated task record.
