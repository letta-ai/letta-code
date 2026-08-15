# TaskList

List all tasks in the current session, in creation order.

Tasks removed with `status: "deleted"` are excluded from the output and cannot be retrieved.

## When to use

- Check current progress without scrolling back through the transcript
- Verify state before committing to a sequence of `TaskUpdate` calls
- Confirm task IDs before wiring `addBlocks` / `addBlockedBy` dependencies

## Returns

```
{ "tasks": [TaskRecord, ...] }
```

Each `TaskRecord` includes `taskId`, `subject`, `description`, `activeForm`, `status`, `owner`, `blocks`, `blockedBy`, `metadata`, `createdAt`, `updatedAt`.
