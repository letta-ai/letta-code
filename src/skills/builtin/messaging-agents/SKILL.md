---
name: messaging-agents
description: Send a message to another Letta agent, continue a thread with one, check on it, or reply to a message another agent sent you. Use when you need to ask, inform, or coordinate with another agent, or when a message from another agent arrives.
---

# Messaging Agents

## What you are addressing

An **agent** is a persistent identity: its memory and configuration are shared
by all of its conversations. A **conversation** is one message thread on an
agent. Address a conversation ID to continue a thread; address an agent ID to
open a new thread with that agent. When your send identifies you as the sender,
a new thread is created hidden so agent-to-agent traffic does not clutter the
recipient's conversation list.

## Two backends

Letta Code keeps agent state on one of two backends. The same CLI addresses
agents on either; what differs is what happens after you send.

**Cloud backend** (api.letta.com). Agent state lives in Cloud. Each turn of a
conversation executes on a *computer*: a machine running Letta Code that is
connected to Cloud, or a Cloud sandbox. Because state and execution are
separate, Cloud tracks which computers are online and where each conversation
is active. That is why these exist only on this backend:

- delivering your message to the harness already running the recipient's
  conversation, or to its saved computer or a Cloud sandbox when none is
  running, instead of running the recipient's turn in your own process;
- a `computer` selector on sends and on the Agent tool;
- teleporting a conversation (`letta teleport <computer>`): the same thread,
  with its history and memory, continues on a different computer. Files and
  working directories do not move with it.

**Local backend.** Agent state lives in a store on this machine. There is no
computer concept, so no `computer` selector and no teleport, and no Cloud
service to deliver on your behalf: a send runs the recipient's turn inside the
`letta -p` process you launched. Agent IDs on this backend start with
`agent-local-`.

"Local backend" describes where state is stored. It says nothing about which
machine a Cloud-backed agent is executing on, and it is unrelated to subagents
you launch with the Agent tool.

## How a send reaches the recipient

On the Cloud backend, `letta -p` hands the message to Cloud for delivery when
you pass `--conversation`, `--from-agent`, `--no-wait`, or `--computer`. With
only `--agent`, it instead runs that agent's turn in your own process, the way
any headless run does. `SendAgentMessage` is Cloud delivery as a tool call.
On the local backend every send runs the recipient's turn in the launched
process.

`--no-wait` decides only whether the CLI waits for the recipient's final
message. It does not change how the message is delivered.

The recipient learns who is asking only when the send identifies a sender:
`--from-agent`, or on the Cloud delivery path the `LETTA_AGENT_ID` and
`LETTA_CONVERSATION_ID` of the agent running the command. `SendAgentMessage`
always identifies you. An identified send attaches a system reminder telling
the recipient how to get its answer back to you. A plain `letta -p` with
neither attaches nothing; the recipient sees only your text, as from any user.

## Waiting or not

- **Waiting send** (`letta -p` without `--no-wait`). The process returns the
  recipient's final message in `result`. An identified recipient is told to
  put its answer in that message. Works on either backend.
- **Non-waiting send** (`SendAgentMessage`, or `letta -p --no-wait`). Returns
  a receipt once Cloud accepts the message. The recipient gets your agent and
  conversation IDs as a return address and must reply with a send of its own;
  the reply arrives as a new message in your conversation. Cloud backend only.

A waiting send occupies the CLI process, not necessarily you. Run it in the
background (your shell tool may already do this for long-running commands) and
read its output when it finishes. That keeps you working, but it does not
change the recipient's instructions: the answer still arrives as process
output, not as a message to your conversation.

For a managed child task with a completion notification, use the Agent tool on
either backend. `SendAgentMessage` only sends input; it creates no task.

## Send and keep working (Cloud backend)

```typescript
SendAgentMessage({ conversation_id: "conv-…", message: "…" })   // continue a thread
SendAgentMessage({ agent_id: "agent-…", message: "…" })         // open a new hidden thread
SendAgentMessage({ agent_id: "agent-…", conversation_id: "default", message: "…" })  // the agent's default thread
```

Success means Cloud accepted the message (`status: "queued"`), not that the
recipient has read it. Keep working; the reply arrives in your conversation.
Omit `computer`: the conversation continues wherever it is active, and asking
for a different computer is rejected rather than moving it.

The CLI form behaves the same; use it from scripts or when the tool is absent:

```bash
letta -p --conversation <conversation-id> --no-wait --output-format json "message"
letta -p --agent <agent-id> --no-wait --output-format json "message"
```

## Send and wait (either backend)

```bash
letta -p --from-agent $LETTA_AGENT_ID --agent <agent-id> --output-format json "message"
letta -p --from-agent $LETTA_AGENT_ID --conversation <conversation-id> --output-format json "follow-up"
```

`result` holds the recipient's final message; `conversation_id` is the thread
to continue. `--from-agent` names you and must be an agent on the same backend
as the recipient.

If your agent ID starts with `agent-local-`, add `--backend local` so the
command uses the local store: `letta --backend local -p …`. The flag applies to
that command only.

On the Cloud backend the recipient executes on its own computer; if your wait
times out or is interrupted, the recipient's work continues. On the local
backend the recipient's turn runs inside the process you launched, so
`--tools`, `--permission-mode`, and the working directory you give it apply to
that turn.

## Replying to another agent

When another agent identifies itself, its message arrives with a system
reminder naming its agent and conversation IDs.

- If the reminder says the sender will only see your final message: answer in
  your response. Nothing more is needed.
- If it gives a return address: reply explicitly with
  `SendAgentMessage({ agent_id, conversation_id, message })`, or
  `letta -p --agent <sender-agent-id> --conversation <sender-conversation-id> --no-wait "reply"`.
  Your ordinary output is not forwarded to the sender.

A message with no reminder is an ordinary user message; answer it normally.

## Checking on a conversation

Recent messages, newest first, are the quick progress check on either backend
(add `--backend local` in the same cases as for sends):

```bash
letta messages list --conversation <conversation-id> --limit 10
```

`letta messages status --conversation <id>` (Cloud only) reports whether the
conversation is currently running and its latest run, so you can tell an idle
thread from one still working on your message. Non-waiting receipts include
ready-to-run `status_command` and `messages_command` values for the thread
they went to. `letta messages transcript --conversation <id>` exports a whole
thread. `letta messages --help` lists the options.

## Finding an agent

```bash
letta agents list --query "name"
letta messages search --query "topic" --all-agents   # discovery; results include agent_id
```

Load the `finding-agents` skill for more search options.

## Choosing a computer (Cloud backend)

Only when a specific machine is required:

```bash
letta computers list --online-only        # connectionName and deviceId
letta -p --agent <agent-id> --computer <name-or-device-id> --no-wait "message"
letta -p --agent <agent-id> --computer cloud --no-wait "message"   # its Cloud sandbox
```

If the conversation is active on another computer the send is rejected; to
move a conversation, teleport it (see the `working-across-computers` skill).
`letta computers --help` covers the selectors.

## Gotchas

- `SendAgentMessage`, `--no-wait`, `--computer`, and `messages status` fail on
  the local backend even when they are offered. Check your agent ID prefix.
- On the Cloud backend, `letta -p --agent <id> "message"` with nothing else
  runs that agent's turn inside your own process instead of delivering to the
  harness running it. Add `--from-agent $LETTA_AGENT_ID` to deliver and
  identify yourself.
- Cloud delivery rejects execution flags (`--tools`, `--permission-mode`,
  `--model`, `--system`, and similar); the recipient keeps its own
  configuration. On the local backend those flags shape the turn you launched.
- `--conversation default` needs `--agent`; `default` is scoped to an agent.
- A receipt means accepted, not delivered. If a send's outcome is unknown
  (`acceptance_unknown`, a timed-out wait), read the thread before resending.

## Related

- `letta --help` and each subcommand's `--help` are the reference for flags;
  this skill explains the concepts and the common recipes.
- `finding-agents`: locate agents by name, tags, or search.
- `working-across-computers`: teleporting and moving files between computers.
- `dispatching-coding-agents`: driving Claude Code or Codex through their
  CLIs, including background execution and collecting results. The same
  pattern applies to a Letta Code instance on another backend: run the
  waiting-send commands above inside it with a `--from-agent` that exists
  there.
