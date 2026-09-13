# Messaging CLI Reference

Detail for `letta -p` sends and the commands around them. Read `SKILL.md`
first; it explains the two backends and the two send modes this file assumes.

## Flags for `letta -p` sends

| Flag | Backend | Effect |
|------|---------|--------|
| `--agent <id>` | either | Open a new thread on that agent (or, with `--conversation default`, use its default thread). |
| `--conversation <id>` | either | Continue an existing thread. `default` requires `--agent`. |
| `--from-agent <id>` | either | Identify the sender. Waiting sends need it so the recipient is told who is asking and so a new thread is created hidden. Non-waiting Cloud sends take the sender from `LETTA_AGENT_ID` / `LETTA_CONVERSATION_ID`; pass `--from-agent` only to send as a different agent, in which case no return conversation is attached. |
| `--no-wait` | Cloud | Return a receipt once Cloud accepts the message. Errors on the local backend. |
| `--computer <selector>` | Cloud | Choose the computer for the recipient's turn (below). Errors on the local backend. |
| `--backend local` | local | Use the local store for this command. Required when the agents involved have `agent-local-` IDs and your session is not already on the local backend. |
| `--output-format json` | either | Structured output; `text` and `stream-json` also work for waiting sends. `--input-format stream-json` is rejected for Cloud sends. |
| `--tools`, `--permission-mode`, `--model`, `--system`, `--max-turns`, `--toolset`, … | local only | Configure the turn that runs in this process. Cloud sends reject them because the recipient runs with its own configuration. |

Sender and recipient must exist on the same backend: a waiting send resolves
`--from-agent` on the backend it is sending to.

## Routing a Cloud send to a computer

Omit `--computer` unless a specific machine is required. Cloud then uses the
conversation's active or saved computer, or starts a Cloud sandbox.

```bash
letta computers list --online-only     # alias: letta envs list --online-only
letta computers current                 # this machine, when it is registered
```

Use `connectionName` or `deviceId` from the JSON as the selector; prefer
`deviceId` when a name is ambiguous. A device ID identifies the registered
computer; a connection ID identifies its temporary listener connection (also
accepted, but not stable). `computers list` marks the current runtime with
`"isCurrent": true`.

```bash
# recipient's own Cloud sandbox
letta -p --agent <agent-id> --computer cloud --no-wait "message"

# the computer this command runs on
CURRENT_COMPUTER=$(letta computers current | jq -r .deviceId)
letta -p --agent <agent-id> --computer "$CURRENT_COMPUTER" --no-wait "message"
```

Selecting a computer does not move a conversation that is active elsewhere;
Cloud rejects the send. Selecting an offline computer also fails. Read the
error and choose again; do not fall back to running the recipient's turn in
your own process. To move a conversation, teleport it instead (see the
`working-across-computers` skill).

The Agent tool takes the same `computer` selector when you want a managed
child task on a particular machine.

## Receipts and results

A non-waiting send (tool or `--no-wait`) prints a receipt:

| Field | Meaning |
|-------|---------|
| `status` | `queued`: Cloud accepted the message. Not proof of delivery or completion. |
| `agent_id`, `conversation_id` | Where the message went. Keep `conversation_id` to continue the thread. |
| `client_message_id` | Your idempotency key for this send. |
| `workflow_id`, `super_run_id` | Cloud's identifiers for the run that will process it. |
| `status_command`, `messages_command` | Ready-to-run commands for inspecting the thread. |

A waiting send prints the recipient's final message in `result`, with
`agent_id`, `conversation_id`, and `run_ids`. Tool calls and reasoning are not
included; the recipient is told to put anything you need in that message. On
the Cloud backend the waiting result also retains the receipt IDs above.

## Investigating a send

```bash
letta messages status --agent <agent-id> --conversation <conversation-id>   # Cloud only
letta messages list --agent <agent-id> --conversation <conversation-id>
letta messages transcript --conversation <conversation-id>
```

`messages status` reports the conversation's current runtime state and
`latest_super_run`. Compare `latest_super_run.id` with your receipt's
`super_run_id`: a different ID belongs to another send, and an idle
conversation alone does not prove your message was processed. On the local
backend use `letta --backend local messages list --conversation <id>`.

Failure shapes to recognise:

- `submission_failed`: Cloud rejected the send (a 4xx). Nothing was queued; fix
  the request.
- `acceptance_unknown`: the request was sent but acceptance could not be
  confirmed (timeout, lost connection, malformed receipt). It may have arrived.
  Run `messages_command` before resending.
- `wait_failed` (CLI, waiting Cloud send): the message was accepted but the
  wait ended, for example "Stopped waiting" or "Interrupted waiting". The
  recipient's work was not cancelled. Inspect the thread before resending.

Cloud owns delivery after acceptance; a queued message is never retried by
executing the recipient's turn in your process.

## Hidden conversations

Threads that one agent opens on another with a known sender are created hidden
on the recipient, so agent-to-agent traffic does not clutter its conversation
list in the ADE. Continuing a hidden thread keeps it hidden; messaging works
normally.

To inspect them, keep the `conversation_id` you were given and read it with
`letta messages transcript --conversation <id>`, or list hidden threads through
the API with `archive_status=archived` (or `all`).

## What the recipient sees

Your message is delivered with a system reminder as a separate text part.

Non-waiting send with a return conversation (Cloud):

```
<system-reminder>
This message is from agent agent-xxx, conversation conv-xxx.
To reply to agent agent-xxx, conversation conv-xxx, use SendAgentMessage if available. Otherwise run letta -p --agent agent-xxx --conversation conv-xxx --no-wait "your reply". Ordinary assistant output is not forwarded to the sender.
</system-reminder>
```

Non-waiting send with `--from-agent` set to a different agent than the caller
(no return conversation): the reminder names the sender and states that
ordinary output is not forwarded and no return conversation was supplied.

Waiting send (Cloud):

```
<system-reminder>
This message is from agent agent-xxx, conversation conv-xxx.
The sender will only see the final message you generate (not tool calls or reasoning). Include your answer in your final response.
</system-reminder>
```

Waiting send (local backend):

```
<system-reminder>
This message is from "<sender name>" (agent ID: agent-local-xxx), an agent currently running inside the Letta Code CLI (docs.letta.com/letta-code).
The sender will only see the final message you generate (not tool calls or reasoning).
If you need to share detailed information, include it in your response text.
</system-reminder>
```
