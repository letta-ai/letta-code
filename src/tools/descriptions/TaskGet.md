# TaskGet

Fetch a single task by its `taskId`.

Returns the full task record, including `subject`, `description`, `status`, `owner`, dependency edges (`blocks`, `blockedBy`), and `metadata`.

## Notes

- Errors if the task ID doesn't exist or was deleted.

## Example

```
TaskGet({ taskId: "task_3" })
```
