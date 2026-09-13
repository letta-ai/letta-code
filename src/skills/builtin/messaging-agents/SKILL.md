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

**Cloud backend** (api.letta.com). Agent state lives in Cloud. Cloud can deliver
messages to a *computer*: a machine running Letta Code connected to Cloud,
or a Cloud sandbox. Because state and execution are
separate, Cloud tracks which computers are online and where each conversation
is active. That is why these exist only on this backend:

- delivering your message to the harness already running the recipient's
  conversation, or to its saved destination (a computer or Cloud sandbox)
  when none is active;
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

For the Cloud CLI sends below, `letta -p` hands the message to Cloud for
delivery when you pass `--conversation`, `--from-agent`, `--no-wait`, or
`--computer`. These commands leave the recipient's execution settings unchanged.
`SendAgentMessage` uses the same Cloud delivery endpoint.

With only `--agent`, the CLI chooses the launch settings and normally creates a
new conversation. It runs the turn in its own process or reuses an inherited
Cloud listener. The listener path first applies those settings to the
conversation, then submits its input through the same Cloud delivery endpoint.
Supported local-backend CLI sends run the turn in the launched process.

`--no-wait` is one of the flags that selects Cloud delivery. On that path,
waiting and non-waiting sends use the same delivery mechanism, but differ in
how you receive the answer and what reply instructions the recipient gets.

The recipient learns who is asking only when the send identifies a sender:
`--from-agent`, or for the Cloud messaging recipes below, the caller IDs from
the agent's shell environment (`AGENT_ID`/`LETTA_AGENT_ID` and
`CONVERSATION_ID`/`LETTA_CONVERSATION_ID`). `SendAgentMessage`
always identifies you and your conversation. An identified send attaches a
system reminder telling the recipient how to get its answer back to you. A
`letta -p` with neither carries no sender or reply instructions; the recipient
receives your text as user input, plus whatever context its harness normally
adds.

An explicit `--from-agent` different from the agent identified by your
environment does not inherit the current conversation as its return address.

## Waiting or not

- **Waiting send** (`letta -p` without `--no-wait`). The process normally returns
  the recipient's final message, in `result` with JSON output. When a sender is
  identified, the recipient is told to put its answer in that message. Works
  on either backend.
- **Non-waiting send** (`SendAgentMessage`, or `letta -p --no-wait`). Returns
  a receipt once Cloud accepts the message. Ordinary assistant output is not
  forwarded. When a sender is identified, the reminder says so and, if a return
  conversation is supplied, asks the recipient to send an explicit reply there.
  That explicit reply becomes a new message in your conversation. Cloud backend
  only; acceptance does not guarantee a reply.

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
recipient has read it. Keep working; a reply sent to your return address
arrives in your conversation.
Omit `computer`: the conversation continues wherever it is active, and asking
for a different computer is rejected rather than moving it.

The CLI form behaves the same when run from your agent's environment, which
supplies the return address; use it from scripts or when the tool is absent:

```bash
letta -p --conversation <conversation-id> --no-wait --output-format json "message"
letta -p --agent <agent-id> --no-wait --output-format json "message"
```

## Send and wait (either backend)

```bash
letta -p --from-agent $LETTA_AGENT_ID --agent <agent-id> --output-format json "message"
letta -p --from-agent $LETTA_AGENT_ID --conversation <conversation-id> --output-format json "follow-up"
```

`result` normally holds the recipient's final message; `conversation_id` is
the thread to continue. `--from-agent` names you and must be an agent on the
same backend as the recipient.

If your agent ID starts with `agent-local-`, add `--backend local` so the
command uses the local store: `letta --backend local -p …`. The flag applies to
that command only.

For these Cloud messaging commands, stopping the wait does not cancel accepted
work on the recipient's computer. On the local backend the recipient's turn
runs inside the process you launched, so
`--tools`, `--permission-mode`, and the working directory you give it apply to
that turn.

## Replying to another agent

When another agent identifies itself, its message arrives with a system
reminder naming its agent ID and, when it had one, its conversation ID.

- If the reminder says the sender will only see your final message: answer in
  your response. Nothing more is needed.
- If the reminder asks for an explicit reply: use its return address with
  `SendAgentMessage({ agent_id, conversation_id, message })`, or
  `letta -p --agent <sender-agent-id> --conversation <sender-conversation-id> --no-wait "reply"`.
  Your ordinary output is not forwarded to the sender.
- If it says no return conversation was supplied: your output is not forwarded
  and there is no thread to reply into. Answer as you normally would.

A message without such a reminder carries no sender or reply instructions;
respond to it as you would to any input.

## Checking on a conversation

Recent messages are the quick progress check on either backend. This command
requests recent messages and prints the returned messages oldest to newest (add
`--backend local` in the same cases as for sends):

```bash
letta messages list --conversation <conversation-id> --limit 10
```

`letta messages status --conversation <id>` (Cloud only) reports whether the
conversation is currently running. When `latest_super_run` is present, compare
its `id` with the `super_run_id` on your receipt; a different ID belongs to a
different send. Read the messages to see what was processed. Non-waiting
receipts include ready-to-run `status_command` and `messages_command` values for the thread
they went to. `letta messages transcript --conversation <id>` exports the
thread; check `truncated` before treating it as complete.
`letta messages --help` lists the options.

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
An offline saved computer does not trigger a Cloud-sandbox fallback.
`letta computers --help` covers the selectors.

## Gotchas

- `SendAgentMessage`, `--no-wait`, `--computer`, and `messages status` fail on
  the local backend even when they are offered. Check your agent ID prefix.
- For Cloud coordination, do not rely on `--agent` alone to select message
  delivery. Add `--from-agent $LETTA_AGENT_ID` to deliver and identify yourself;
  pass `--conversation <id>` to reach an existing thread.
- The Cloud messaging recipes above reject execution flags (`--tools`,
  `--permission-mode`, `--model`, `--system`, and similar); the recipient keeps
  its own configuration. Those flags configure a launch when using the
  retained `--agent`-only path or local-backend execution.
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
