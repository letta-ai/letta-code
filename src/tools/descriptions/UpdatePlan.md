# update_plan

Records or updates a structured task plan, compatible with Codex's `update_plan` tool.

- **plan**: Required array of plan items, each with a `step` (short description) and `status` (`pending`, `in_progress`, or `completed`).
- **explanation**: Optional free-form explanation of why the plan changed or what was done.
- At most one item should have status `in_progress` at a time.






