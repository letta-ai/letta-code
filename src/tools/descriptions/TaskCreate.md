# TaskCreate

Create a new task in the session task list.

Tasks help you track progress on complex, multi-step work and show the user what you're planning to do. Each task gets a stable ID you can reference from `TaskGet`, `TaskList`, and `TaskUpdate`.

## When to use this tool

Use TaskCreate proactively for:

1. **Complex multi-step tasks** — 3+ distinct steps or actions
2. **Non-trivial tasks** — careful planning or multiple operations required
3. **User provides multiple tasks** — numbered lists, comma-separated requests
4. **New instructions arrive** — capture user requirements as tasks immediately
5. **Starting work** — create the task, then `TaskUpdate` it to `in_progress`

## When NOT to use this tool

- Single, trivial task — just do it
- Purely informational or conversational replies
- Tasks that take fewer than 3 trivial steps

## Required fields

- `subject` — short imperative (e.g. "Run tests", "Fix auth bug")
- `description` — full description with enough context to be actionable later

## Optional fields

- `activeForm` — present-continuous form shown during execution (e.g. "Running tests")
- `metadata` — free-form `{string: string}` bag for ad-hoc annotations

## Example

```
TaskCreate({
  subject: "Add dark mode toggle",
  description: "Add a dark mode toggle to the Settings page. Wire it into the existing theme context and persist the preference to localStorage.",
  activeForm: "Adding dark mode toggle",
  metadata: { area: "ui", priority: "medium" }
})
```

Returns the full task record including the assigned `taskId`.
