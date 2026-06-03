# TaskGet

Fetch a single task by its `taskId`.

Returns the full task record, including `subject`, `description`, `status`, `owner`, dependency edges (`blocks`, `blockedBy`), and `metadata`.

## Notes

- Works on soft-deleted tasks (`status: "deleted"`) too — `TaskGet` returns the record even though `TaskList` hides it by default.
- Errors if the task ID doesn't exist.

## Example

```
TaskGet({ taskId: "task_3" })
```
