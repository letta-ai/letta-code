Create a new task in the session task list. Tasks track progress on multi-step work and show the user what you're planning; each gets a stable ID for `TaskGet`, `TaskList`, and `TaskUpdate`.

Use it proactively for work with 3+ distinct steps, when the user gives several tasks, or when new requirements arrive. Skip it for single, trivial, or purely conversational work. When starting a task, `TaskUpdate` it to `in_progress`.

- `subject`: short imperative (e.g. "Run tests").
- `description`: enough context to be actionable later.
- `activeForm` (optional): present-continuous form shown during execution (e.g. "Running tests").

Returns the full task record including the assigned `taskId`.
