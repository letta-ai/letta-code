---
name: scheduling-tasks
description: Schedules reminders and recurring tasks via the letta cron CLI. Use when the user asks to be reminded of something, wants periodic work or check-ins, or needs to list, inspect, replace, or cancel scheduled tasks.
---

# Scheduling Tasks

This skill lets you create, list, and manage scheduled tasks using the `letta cron` CLI. Scheduled tasks send a prompt to the agent on a timer — useful for reminders, periodic check-ins, and deferred follow-ups.

## When to Use This Skill

- User asks to be reminded of something ("remind me to X at Y")
- User wants a recurring check-in ("every morning ask me about X")
- User wants a one-shot delayed message ("in 30 minutes, check on X")
- User wants to see or cancel existing scheduled tasks

## Where Schedules Run — Omit the Flags

**Default guidance: omit `--runner` and `--computer`.** The CLI places the schedule so the work keeps running on the computer where it was created. Don't move scheduled work to a different computer than the active conversation without a reason: two computers working the same conversation can conflict.

Pass a flag only when you have a requirement the default can't infer:

- **`--runner cloud`** — the schedule must fire no matter which computers are online; execute in the agent's cloud sandbox.
- **`--computer <deviceId>`** — the work needs a specific connected computer (its filesystem, services, or credentials). Get the deviceId from `letta environments list`. If that computer is offline at fire time, execution falls back to the cloud sandbox.
- **`--runner local`** — the work must only ever run on the current computer, even if that means missing fires while no session is running here.

The CLI reports its placement in the command output. If it warns that the schedule is local (this happens when the cloud scheduler cannot reach the current computer), the schedule only fires while a Letta session is running here — read the warning and decide whether that's acceptable.

### Fast Follow-ups vs Recurring Jobs

Two patterns cover most schedules:

- **Fast follow-ups** ("check on the PR in 5m"): the default is right — same computer as the active conversation. If the session dies before it fires, the follow-up usually died with the task anyway.
- **Recurring jobs** ("every Monday 11am, start the lunch order"): prefer durability. If the CLI warned that a recurring schedule is local, that's usually wrong for the user's intent — recreate it with `--runner cloud`, or `--computer` if the job needs a specific always-on computer. Also consider whether the job should post into a dedicated conversation rather than this one (continuity in one thread vs a fresh context per run).

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
| `--every <interval>` | Recurring (cron shorthand) | `5m`, `2h`, `1d` |
| `--at <time>` | One-shot | `"3:00pm"`, `"in 45m"` |
| `--cron <expr>` | Raw cron (recurring) | `"0 9 * * 1-5"` |

**Optional flags:**

| Flag | Description |
|------|-------------|
| `--agent <id>` | Agent ID (defaults to `LETTA_AGENT_ID` from the current shell/session) |
| `--conversation <id>` | Conversation ID (defaults to `LETTA_CONVERSATION_ID` from the current shell/session, otherwise `"default"`) |
| `--runner <runner>` | `cloud` or `local` — normally omit; see "Where Schedules Run" above |
| `--computer <id>` | Execute on a specific connected computer — normally omit |
| `--once` | Mark `--at` as one-shot (already the default for `--at`) |

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

For local run history, `--run-id <id>` selects one run. Cloud history ignores that flag.

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

`delete` accepts an ID or name; `remove` is an alias.

```bash
# Delete a specific task
letta cron delete <id-or-name> [--runner local|cloud] [--agent <id>]

# Delete all tasks for one agent
letta cron delete --all --agent "$AGENT_ID"
```

In-place editing is not available. To change a schedule, create and verify the replacement before deleting the old one.

## Timezones — Convert Before Writing `--cron`

Cloud-schedule recurring expressions (both `--cron` and the expression `--every` compiles to) are interpreted in **UTC**. Users say times in their local timezone, so convert before writing the expression: a user in PDT asking for "9am daily" needs `--cron "0 16 * * *"` (9am PDT = 16:00 UTC; 17:00 during PST). State the conversion in your reply so the user can catch a wrong assumption. Local-runner tasks use the computer's local timezone — no conversion. `--at` stores one absolute timestamp parsed in the current process timezone, so it needs no conversion either.

## Examples

### "Remind me every morning at 9am to walk the dog" (user in UTC−7)

```bash
letta cron add \
  --name "dog-walk-reminder" \
  --description "Daily 9am (America/Los_Angeles) reminder to walk the dog" \
  --prompt "Hey! It's 9am — time to walk the dog." \
  --cron "0 16 * * *"
```

Note: `--every 1d` fires daily at midnight (UTC on a Cloud schedule), so use `--cron` for a specific time of day, converting the user's local time to UTC first.

### "Check on the deploy in 30 minutes"

```bash
letta cron add \
  --name "deploy-check" \
  --description "One-time check on deployment status" \
  --prompt "Check the deployment status and report the result here." \
  --at "in 30m"
```

### "Every weekday at 5pm, remind me to submit my timesheet" (user in UTC−7)

```bash
letta cron add \
  --name "timesheet-reminder" \
  --description "Weekday 5pm (America/Los_Angeles) timesheet reminder" \
  --prompt "Friendly reminder: don't forget to submit your timesheet before EOD!" \
  --cron "0 0 * * 2-6"
```

Note the day shift: 5pm UTC−7 is midnight UTC the *next* day, so weekdays Mon–Fri become `2-6`. Always re-derive both the hour and the day fields after converting.

### "What reminders do I have?"

```bash
letta cron list
```

If you need to confirm the exact conversation a task is bound to, list with explicit filters instead:

```bash
letta cron list --agent "$AGENT_ID" --conversation "$CONVERSATION_ID"
```

### "Cancel the dog walk reminder"

```bash
letta cron delete dog-walk-reminder
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
- **Default binding precedence**: `letta cron add` uses `--agent` / `--conversation` first, then falls back to `LETTA_AGENT_ID` / `LETTA_CONVERSATION_ID`, then finally uses `"default"` for the conversation if no env var is present.
- **Local scheduler requirement**: Local schedules only fire while a Letta session is running on their computer; fires while no session runs are marked as missed. Cloud schedules fire from the cloud regardless.
- **`--at` for specific times**: `--at "3:00pm"` schedules a one-shot. If the time has already passed today, it schedules for tomorrow.
- **Cloud schedule creation failures are loud**: if creating a cloud schedule fails, no schedule is created — a failed create never silently becomes a local schedule. (The local placement for computers the cloud scheduler can't reach is decided before creation and reported in the output.)

## Cron Expression Reference

For `--cron`, use numeric 5-field cron syntax (named days/months, seconds, `?`, `L`, and `#` are not supported):

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sun=0)
│ │ │ │ │
* * * * *
```

Common patterns (UTC on Cloud schedules):
- `*/5 * * * *` — every 5 minutes
- `0 */2 * * *` — every 2 hours
- `0 9 * * *` — daily at 9:00 UTC
- `0 9 * * 1-5` — weekdays at 9:00 UTC
- `30 8 1 * *` — 8:30 UTC on the 1st of each month
