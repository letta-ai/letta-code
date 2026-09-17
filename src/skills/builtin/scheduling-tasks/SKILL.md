---
name: scheduling-tasks
description: Schedules reminders, recurring tasks, and conversation-bound iMessage outreach via the letta cron CLI. Use when the user asks to be reminded of something, wants periodic work or check-ins, wants a scheduled iMessage message, or needs to list, inspect, replace, or cancel scheduled tasks.
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
- **`--computer <deviceId>`** — the work needs a specific connected computer (its filesystem, services, or credentials). Get the deviceId from `letta computers list`. If that computer is offline at fire time, execution falls back to the cloud sandbox.
- **`--runner local`** — the work must only ever run on the current computer, even if that means missing fires while no session is running here.

The CLI reports its placement in the command output. If it warns that the schedule is local (this happens when the cloud scheduler cannot reach the current computer), the schedule only fires while a Letta session is running here — read the warning and decide whether that's acceptable.

### Fast Follow-ups vs Recurring Jobs

Two patterns cover most schedules:

- **Fast follow-ups** ("check on the PR in 5m"): the default is right — same computer as the active conversation. If the session dies before it fires, the follow-up usually died with the task anyway.
- **Recurring jobs** ("every Monday 11am, start the lunch order"): prefer durability. If the CLI warned that a recurring schedule is local, that's usually wrong for the user's intent — recreate it with `--runner cloud`, or `--computer` if the job needs a specific always-on computer. A fresh conversation per run is the default; pass a conversation explicitly when the job needs continuity in one thread.

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
| `--conversation <id>` | Conversation target: omit or pass `new` for a fresh conversation per fire; pass `self` for the current conversation; pass `default` for the agent default; or pass a concrete ID |
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

`letta cron add` falls back to `LETTA_AGENT_ID` for the agent. An omitted `--conversation` means `"new"`, so every fire gets a fresh conversation. Pass `--conversation self` to capture the current `LETTA_CONVERSATION_ID`, `--conversation default` for the agent default, or a concrete conversation ID.

Safest pattern:

```bash
letta cron add \
  --name "email-check" \
  --description "Daily email summary in this conversation" \
  --prompt "Check the user's email and post a summary here." \
  --cron "0 10 * * *" \
  --agent "$LETTA_AGENT_ID" \
  --conversation self
```

Then verify the binding explicitly:

```bash
letta cron list --agent "$LETTA_AGENT_ID" --conversation self
```

### Preserve iMessage Conversation Continuity

If a scheduled turn will send through `MessageChannel` and the recipient may
reply, run it in the channel route's existing conversation. A fresh scheduled
conversation can deliver the outbound message, but the recipient's reply returns
to the route conversation without the scheduled turn or tool result in context.

- When the request arrived in the target iMessage conversation, pass
  `--conversation self`.
- Never omit `--conversation` or pass `new` for a scheduled message that should
  continue an existing channel conversation.
- Store every exact opaque routing argument in the prompt. Do not rely on the
  scheduled agent recovering them from conversation history after compaction.
- Include `action="send"` and the actual message in an explicit `MessageChannel`
  call. An ordinary assistant response is not a channel delivery.

For scheduled iMessage outreach, resolve and schedule the exact paired route in
one guarded shell call. This prevents a failed request from becoming an empty
but apparently successful route and keeps shell-local values available while
the prompt is constructed. Select by the current conversation and require
exactly one paired route; do not copy phone-derived fields from the response.
Encode the exact message, schedule name, and description as Base64 **outside the
shell command**, then replace only the three Base64 placeholders and the schedule
flag below. Never paste raw external text into shell source: `$`, quotes,
backticks, command substitutions, backslashes, and multiline content must remain
data rather than becoming Bash syntax.

```bash
set -euo pipefail

message_b64="<base64 of exact UTF-8 message>"
schedule_name_b64="<base64 of short name>"
schedule_description_b64="<base64 of description>"
agent_id="${AGENT_ID:-${LETTA_AGENT_ID:?missing agent ID}}"
current_conversation_id="${CONVERSATION_ID:-${LETTA_CONVERSATION_ID:?missing conversation ID}}"

connections_json="$(curl -fsS \
  "$LETTA_BASE_URL/v1/agents/$agent_id/imessage/connection" \
  -H "Authorization: Bearer $LETTA_API_KEY")"
if [[ -z "${connections_json//[[:space:]]/}" ]]; then
  echo "iMessage route lookup returned an empty response" >&2
  exit 1
fi

route_json="$(jq -cer \
  --arg conversation_id "$current_conversation_id" '
  if type != "object" or (.connections | type) != "array" then
    error("invalid iMessage route response")
  else
    [.connections[] |
      select(
        .conversation_id == $conversation_id and .status == "paired"
      ) |
      {id, conversation_id, integration_id}] |
    if length == 1 then .[0]
    else error("expected exactly one paired route for this conversation") end
  end
' <<<"$connections_json")"
unset connections_json
if [[ -z "${route_json//[[:space:]]/}" ]]; then
  echo "iMessage route projection was empty" >&2
  exit 1
fi

target_route_id="$(jq -er '.id | select(type == "string" and length > 0)' <<<"$route_json")"
target_conversation_id="$(jq -er '.conversation_id | select(type == "string" and length > 0)' <<<"$route_json")"
target_account_id="$(jq -er '.integration_id | select(type == "string" and length > 0)' <<<"$route_json")"
if [[ -z "$target_route_id" || -z "$target_conversation_id" || -z "$target_account_id" ]]; then
  echo "iMessage route contains an empty required field" >&2
  exit 1
fi
decoded_fields_json="$(node - \
  "$message_b64" \
  "$schedule_name_b64" \
  "$schedule_description_b64" \
  "$target_route_id" \
  "$target_account_id" <<'NODE'
const [messageBase64, nameBase64, descriptionBase64, routeId, accountId] =
  process.argv.slice(2);
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });
function decode(label, value) {
  if (!base64Pattern.test(value)) throw new Error(`${label} is not valid padded Base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical Base64`);
  const text = utf8.decode(bytes);
  if (text.length === 0) throw new Error(`${label} must be non-empty`);
  if (text.includes("\0")) throw new Error(`${label} must not contain NUL`);
  return text;
}
const message = decode("message", messageBase64);
const scheduleName = decode("schedule name", nameBase64);
const scheduleDescription = decode("schedule description", descriptionBase64);
process.stdout.write(JSON.stringify({
  scheduleName,
  scheduleDescription,
  messageChannelArgs: {
    action: "send",
    channel: "imessage",
    chat_id: routeId,
    accountId,
    message,
  },
}));
NODE
)"
schedule_name="$(jq -er '.scheduleName | select(type == "string" and length > 0)' <<<"$decoded_fields_json")"
schedule_description="$(jq -er '.scheduleDescription | select(type == "string" and length > 0)' <<<"$decoded_fields_json")"
message_channel_args="$(jq -cer '.messageChannelArgs' <<<"$decoded_fields_json")"
unset decoded_fields_json
prompt="When this schedule fires, call MessageChannel exactly once with these exact arguments: $message_channel_args. Do not only reply in the conversation."

inspect_ambiguous_schedules() {
  local runner list_json list_status
  for runner in local cloud; do
    set +e
    list_json="$(letta cron list \
      --runner "$runner" \
      --agent "$agent_id" \
      --conversation "$target_conversation_id")"
    list_status=$?
    set -e
    if (( list_status != 0 )); then
      echo "$runner schedule inspection failed; do not retry cron add." >&2
    elif [[ -z "${list_json//[[:space:]]/}" ]]; then
      echo "$runner schedule inspection returned no JSON; do not retry cron add." >&2
    elif ! jq -cer \
      --arg runner "$runner" '
      if type != "array" then error("invalid schedule list response")
      else map({id, runner: (.runner // $runner), name, conversation_id}) end
    ' <<<"$list_json" >&2; then
      echo "$runner schedule inspection was unparseable; do not retry cron add." >&2
    fi
    unset list_json
  done
  echo "Recovery output can be empty or incomplete and never authorizes retrying cron add; creation may have committed." >&2
}

set +e
created_json="$(letta cron add \
  --name "$schedule_name" \
  --description "$schedule_description" \
  --prompt "$prompt" \
  --at "in 30m" \
  --agent "$agent_id" \
  --conversation "$target_conversation_id")"
create_status=$?
set -e
if (( create_status != 0 )) || [[ -z "${created_json//[[:space:]]/}" ]]; then
  echo "cron add had an ambiguous outcome; inspect projected recovery metadata below." >&2
  inspect_ambiguous_schedules
  exit 1
fi
set +e
created_id="$(jq -er '.id | select(type == "string" and length > 0)' <<<"$created_json")"
created_id_status=$?
set -e
if (( created_id_status != 0 )) || [[ -z "$created_id" ]]; then
  echo "cron add returned an unparseable result; inspect projected recovery metadata below." >&2
  inspect_ambiguous_schedules
  exit 1
fi
printf 'Created schedule %s. If verification fails, inspect or delete this ID; do not rerun cron add.\n' "$created_id" >&2
if ! jq -e \
  --arg id "$created_id" \
  --arg agent_id "$agent_id" \
  --arg conversation_id "$target_conversation_id" '
  type == "object" and
  .id == $id and
  .agent_id == $agent_id and
  .conversation_id == $conversation_id
' <<<"$created_json" >/dev/null; then
  echo "Created schedule $created_id but its create response did not match the requested scope. Inspect or delete that ID; do not rerun cron add." >&2
  exit 1
fi
set +e
verified_json="$(letta cron get "$created_id" --agent "$agent_id")"
get_status=$?
set -e
if (( get_status != 0 )) || [[ -z "${verified_json//[[:space:]]/}" ]]; then
  echo "Created schedule $created_id but could not verify it. Inspect or delete that ID; do not rerun cron add." >&2
  exit 1
fi
if ! jq -e \
  --arg id "$created_id" \
  --arg conversation_id "$target_conversation_id" \
  --arg prompt "$prompt" '
  type == "object" and
  .id == $id and
  .conversation_id == $conversation_id and
  .prompt == $prompt
' <<<"$verified_json" >/dev/null; then
  echo "Created schedule $created_id but its stored scope or prompt did not match. Inspect or delete that ID; do not rerun cron add." >&2
  exit 1
fi
```

Stop instead of guessing when the route is missing or ambiguous. Route state can
change after schedule creation, so the iMessage gateway revalidates account,
organization, agent, conversation, paired/enabled/outbound state, rollout, and
billing when the schedule fires. Treat a `MessageChannel` error as a failed
delivery; schedule execution alone is not proof of delivery. Never put a phone
number in the prompt or command. If the request did not arrive in the target
iMessage conversation, ask the user to schedule from that conversation instead
of weakening the conversation-match check. If post-creation verification fails,
inspect or delete the printed schedule ID before deciding whether to retry.

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
  --at "in 30m" \
  --agent "$LETTA_AGENT_ID" \
  --conversation self
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
- **Default binding**: `letta cron add` uses `--agent` first, then `LETTA_AGENT_ID`. Omit `--conversation` for a fresh conversation per fire; use `--conversation self` to capture `LETTA_CONVERSATION_ID` explicitly.
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
