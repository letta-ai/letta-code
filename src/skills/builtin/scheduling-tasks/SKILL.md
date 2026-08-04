---
name: scheduling-tasks
description: Schedules reminders and recurring tasks via the letta cron CLI. Use when the user asks to be reminded of something, wants periodic work or check-ins, or needs to list, inspect, replace, or cancel scheduled tasks.
---

# Scheduling Tasks

This skill lets you create, list, and manage scheduled messages using the `letta cron` CLI. Scheduled messages send a prompt to the agent on a timer — useful for reminders, periodic check-ins, and deferred follow-ups.

## When to Use This Skill

- User asks to be reminded of something ("remind me to X at Y")
- User wants a recurring check-in ("every morning ask me about X")
- User wants a one-shot delayed message ("in 30 minutes, check on X")
- User wants to see or cancel existing scheduled tasks

## Clock Location and Execution Target

The `--runner` flag selects where the schedule is stored and its cron clock runs. The execution target selects which computer handles the scheduled message.

- **`cloud`** (default for Cloud agents): the schedule and clock live in Cloud, so they survive local shutdown.
- **`local`**: the schedule and clock live on the current computer in `~/.letta/crons.json`. They only fire while a Letta session runs there.

For a Cloud schedule created from a registered external listener:

- With no `--runner` or `--computer`, execution targets the computer that invoked the command.
- `--computer <deviceId>` targets another registered computer.
- Explicit `--runner cloud` targets the agent's Cloud sandbox.

Get a device ID from `letta environments list`. Managed sandboxes and Desktop-local proxy connections are not valid `--computer` targets.

If a target computer is offline when the clock fires, execution currently falls back to the Cloud sandbox. This fallback cannot be disabled. Do not use `--runner local` only to target the current computer; that also moves the cron clock out of Cloud.

Local-backend agents (`agent-local-*`) and servers without Cloud schedule routes use the local runner.

If Cloud schedule creation fails, no schedule is created. There is no silent fallback to local clock storage.

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
| `--every <interval>` | Recurring cron shorthand | `5m`, `2h`, `1d` |
| `--at <time>` | One-shot | `"3:00pm"`, `"in 45m"` |
| `--cron <expr>` | Raw cron (recurring) | `"0 9 * * 1-5"` |

**Optional flags:**

| Flag | Description |
|------|-------------|
| `--agent <id>` | Agent ID (defaults to `LETTA_AGENT_ID` from the current shell/session) |
| `--conversation <id>` | Conversation ID (defaults to `LETTA_CONVERSATION_ID` from the current shell/session, otherwise `"default"`) |
| `--runner <runner>` | `cloud` or `local`; selects where the cron clock lives |
| `--computer <id>` | For a Cloud clock, select a registered execution computer |
| `--once` | Mark `--at` as one-shot; this is already the default |

### Listing Tasks

```bash
letta cron list
```

Optional filters: `--agent <id>`, `--conversation <id>`, `--runner local|cloud`

### Getting a Single Task

`get` accepts an ID or name:

```bash
letta cron get <id-or-name> [--runner local|cloud] [--agent <id>]
```

### Reading Run History

```bash
letta cron runs --id <task-id> [--limit <n>] [--runner local|cloud] [--agent <id>]
```

For local history, `--run-id <id>` selects one run. Cloud history ignores that flag.

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

### Deleting or Replacing Tasks

`delete` accepts an ID or name. `remove` is an alias.

```bash
# Delete a specific task
letta cron delete <id-or-name> [--runner local|cloud] [--agent <id>]

# Delete all Cloud tasks for one agent
letta cron delete --all --agent "$AGENT_ID" --runner cloud
```

In-place editing is not available. To change a schedule, create and verify its replacement before deleting the old schedule.

## Examples

### "Remind me every morning at 9am UTC to walk the dog"

```bash
letta cron add \
  --name "dog-walk-reminder" \
  --description "Daily 9am UTC reminder to walk the dog" \
  --prompt "Hey! It's 9am — time to walk the dog." \
  --cron "0 9 * * *"
```

### "Check on the deploy in 30 minutes"

```bash
letta cron add \
  --name "deploy-check" \
  --description "One-time check on deployment status" \
  --prompt "Check the deployment status and report the result here." \
  --at "in 30m"
```

### "Every weekday at 5pm UTC, remind me to submit my timesheet"

```bash
letta cron add \
  --name "timesheet-reminder" \
  --description "Weekday 5pm UTC timesheet reminder" \
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
- **One-shot cleanup (local runner)**: One-shot local tasks are garbage-collected 24 hours after firing.
- **Timezone**: Local clocks use the local scheduler timezone. Cloud clocks interpret all recurring expressions in UTC, including expressions produced by `--every`. `--at` stores one absolute time after parsing the current process timezone.
- **Default binding precedence**: `letta cron add` uses `--agent` / `--conversation` first, then falls back to `LETTA_AGENT_ID` / `LETTA_CONVERSATION_ID`, then finally uses `"default"` for the conversation if no env var is present.
- **Local scheduler requirement**: Local-runner tasks only fire while a Letta session is running on that computer (a WS listener must be active). If no session is running, tasks will be marked as missed. Cloud-runner schedules fire from Cloud regardless.
- **`--at` for specific times**: `--at "3:00pm"` schedules a one-shot. If the time has already passed today, it schedules for tomorrow.
- **`--every` is cron shorthand**: Values can be rounded or clamped. `--every 1d` becomes midnight in the clock's timezone.

## Cron Expression Reference

For `--cron`, use numeric 5-field cron syntax. Named days or months, seconds, `?`, `L`, and `#` are not supported.

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sun=0)
│ │ │ │ │
* * * * *
```

For a Cloud clock:
- `*/5 * * * *` — every 5 minutes
- `0 */2 * * *` — every 2 hours
- `0 9 * * *` — daily at 9am UTC
- `0 9 * * 1-5` — weekdays at 9am UTC
- `30 8 1 * *` — 8:30am UTC on the 1st of each month
