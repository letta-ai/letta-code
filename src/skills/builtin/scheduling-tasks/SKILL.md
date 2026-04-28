---
name: scheduling-tasks
description: Schedules reminders and recurring tasks via the letta cron CLI. Use when the user asks to be reminded of something, wants periodic messages, or needs to manage scheduled tasks.
---

# Scheduling Tasks

This skill lets you create, list, and manage scheduled tasks using the `letta cron` CLI. Scheduled tasks send a prompt to the agent on a timer — useful for reminders, periodic check-ins, and deferred follow-ups.

## When to Use This Skill

- User asks to be reminded of something ("remind me to X at Y")
- User wants a recurring check-in ("every morning ask me about X")
- User wants a one-shot delayed message ("in 30 minutes, check on X")
- User wants to see or cancel existing scheduled tasks

## CLI Usage

All commands go through `letta cron` via the Bash tool. Output is JSON.

### Creating a Task

```bash
letta cron add --name <short-name> --description <text> --prompt <text> <schedule>
```

**Required flags:**

| Flag | Description |
|------|-------------|
| `--name <text>` | Short identifier for the task (e.g. "dog-walk-reminder") |
| `--description <text>` | Human-readable description of what the task does |
| `--prompt <text>` | The message that will be sent to the agent when the task fires |

**Schedule (pick one):**

| Flag | Type | Example |
|------|------|---------|
| `--every <interval>` | Recurring | `5m`, `2h`, `1d` |
| `--at <time>` | One-shot | `"3:00pm"`, `"in 45m"` |
| `--cron <expr>` | Raw cron (recurring) | `"0 9 * * 1-5"` |

**Optional flags:**

| Flag | Description |
|------|-------------|
| `--agent <id>` | Agent ID (defaults to `LETTA_AGENT_ID` from the current shell/session) |
| `--conversation <id>` | Conversation ID (defaults to `LETTA_CONVERSATION_ID` from the current shell/session, otherwise `"default"`) |

### Listing Tasks

```bash
letta cron list
```

Optional filters: `--agent <id>`, `--conversation <id>`

### Getting a Single Task

```bash
letta cron get <task-id>
```

### Binding a Task to the Right Conversation

If exact routing matters, pass both `--agent` and `--conversation` explicitly.

`letta cron add` will otherwise fall back to `LETTA_AGENT_ID` and `LETTA_CONVERSATION_ID` from the current shell/session. Those values may be correct for the current chat, but they can also be inherited from surrounding tooling, another conversation, or an older shell.

Safest pattern:

```bash
letta cron add \
  --name "email-check" \
  --description "Daily email summary in this conversation" \
  --prompt "Check the user's email and post a summary here." \
  --cron "0 10 * * *" \
  --agent "$AGENT_ID" \
  --conversation "$CONVERSATION_ID"
```

Then verify the binding explicitly:

```bash
letta cron list --agent "$AGENT_ID" --conversation "$CONVERSATION_ID"
```

### Deleting Tasks

```bash
# Delete a specific task
letta cron delete <task-id>

# Delete all tasks for the current agent
letta cron delete --all
```

## Examples

### "Remind me every morning at 9am to walk the dog"

```bash
letta cron add \
  --name "dog-walk-reminder" \
  --description "Daily morning reminder to walk the dog" \
  --prompt "Hey! It's 9am — time to walk the dog." \
  --every 1d
```

Note: `--every 1d` fires once daily at midnight. For a specific time like 9am, use a raw cron expression:

```bash
letta cron add \
  --name "dog-walk-reminder" \
  --description "Daily 9am reminder to walk the dog" \
  --prompt "Hey! It's 9am — time to walk the dog." \
  --cron "0 9 * * *"
```

### "Check on the deploy in 30 minutes"

```bash
letta cron add \
  --name "deploy-check" \
  --description "One-time check on deployment status" \
  --prompt "The user asked you to check on the deploy — ask them how it went." \
  --at "in 30m"
```

### "Every weekday at 5pm, remind me to submit my timesheet"

```bash
letta cron add \
  --name "timesheet-reminder" \
  --description "Weekday 5pm timesheet reminder" \
  --prompt "Friendly reminder: don't forget to submit your timesheet before EOD!" \
  --cron "0 17 * * 1-5"
```

### "What reminders do I have?"

```bash
letta cron list
```

If you need to confirm the exact conversation a task is bound to, list with explicit filters instead:

```bash
letta cron list --agent "$AGENT_ID" --conversation "$CONVERSATION_ID"
```

### "Cancel the dog walk reminder"

First list to find the task ID, then delete:

```bash
letta cron list
# Find the task ID from the output, then:
letta cron delete <task-id>
```

## Writing Good Prompts

The `--prompt` value is what gets sent to you (the agent) when the task fires. Write it as a message that will make sense when you receive it later, with enough context to act on:

- **Good**: "The user asked to be reminded to review the PR for the auth refactor. Check if it's still open and nudge them."
- **Bad**: "reminder"

Include context about what the user originally asked for, so you can give a helpful response when the prompt arrives.

## Important Notes

- **Minimum granularity**: 1 minute. Intervals under 60 seconds are rounded up.
- **Recurring tasks**: No longer auto-expire. They remain active until explicitly cancelled.
- **One-shot cleanup**: One-shot tasks are garbage-collected 24 hours after firing.
- **Timezone**: Tasks use the user's local timezone by default.
- **Default binding precedence**: `letta cron add` uses `--agent` / `--conversation` first, then falls back to `LETTA_AGENT_ID` / `LETTA_CONVERSATION_ID`, then finally uses `"default"` for the conversation if no env var is present.
- **Scheduler requirement**: Tasks only fire while a Letta session is running (a WS listener must be active). If no session is running, tasks will be marked as missed.
- **`--at` for specific times**: `--at "3:00pm"` schedules a one-shot. If the time has already passed today, it schedules for tomorrow.
- **`--every` for daily**: `--every 1d` fires daily at midnight. For a specific time of day, use `--cron` instead (e.g. `--cron "0 9 * * *"` for 9am daily).

## Cron Expression Reference

For `--cron`, use standard 5-field cron syntax:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sun=0)
│ │ │ │ │
* * * * *
```

Common patterns:
- `*/5 * * * *` — every 5 minutes
- `0 */2 * * *` — every 2 hours
- `0 9 * * *` — daily at 9am
- `0 9 * * 1-5` — weekdays at 9am
- `30 8 1 * *` — 8:30am on the 1st of each month
