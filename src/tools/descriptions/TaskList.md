List all tasks in the current session, in creation order. Deleted tasks are excluded.

Returns `{ "tasks": [TaskRecord, ...] }`; each record includes `taskId`, `subject`, `description`, `activeForm`, `status`, `owner`, `blocks`, `blockedBy`, `metadata`, `createdAt`, `updatedAt`.
