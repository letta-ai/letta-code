---
name: messaging-agents
description: Send a message to another Letta agent, continue a thread with one, or reply to a message another agent sent you. Use when you need to ask, inform, or coordinate with another agent, or when a message from another agent arrives.
---

# Messaging Agents

## What you are addressing

An **agent** is a persistent identity: its memory and configuration are shared
by all of its conversations. A **conversation** is one message thread on an
agent. Address a conversation ID to continue a thread; address an agent ID to
open a new thread with that agent. Threads that one agent opens on another are
created hidden, so they do not clutter the recipient's conversation list.

## Two backends

Letta Code keeps agent state on one of two backends. The same CLI addresses
agents on either; what differs is what the backend can do.

**Cloud backend** (api.letta.com). Agent state lives in Cloud. Each turn of a
conversation executes on a *computer*: a machine running Letta Code that is
connected to Cloud, or a Cloud sandbox. Because state and execution are
separate, Cloud tracks which computers are online and where each conversation
is active. That is what makes the following possible, and why they exist only
on this backend:

- a `computer` selector on sends and on the Agent tool;
- accepting a message now and delivering it to the recipient's computer while
  you keep working (`SendAgentMessage`, `letta -p --no-wait`);
- teleporting a conversation (`letta teleport <computer>`): the same thread,
  with its history and memory, continues on a different computer. Files and
  working directories do not move with it.

**Local backend.** Agent state lives in a store on this machine, and turns run
in the Letta Code process that holds it. There is no computer concept, so there
is no `computer` selector, no queue to hand a message to, and no teleport.
Agent IDs on this backend start with `agent-local-`.

"Local backend" describes where state is stored. It says nothing about which
machine a Cloud-backed agent is executing on, and it is unrelated to subagents
you launch with the Agent tool.

## Two ways to send

Your message reaches the recipient with a system reminder that says how to get
its answer back to you. Which instruction it gets depends on how you send:

- **Non-waiting send** (`SendAgentMessage`, or `letta -p --no-wait`). Returns a
  receipt as soon as Cloud accepts the message. The recipient gets your agent
  and conversation IDs as a return address and must reply with a send of its
  own; the reply arrives as a new message in your conversation. Cloud backend
  only.
- **Waiting send** (`letta -p` without `--no-wait`). The CLI process returns
  the recipient's final message as its output. The recipient is told to put its
  answer in that message. Either backend.

A waiting send occupies the CLI process, not necessarily you. Run it in the
background (your shell tool may already do this for long-running commands) and
collect the output when it finishes. That keeps you working, but it does not
change the recipient's instructions: the answer still arrives as process
output, not as a message to your conversation.

For a managed child task with a completion notification, use the Agent tool on
either backend. `SendAgentMessage` only sends input; it creates no task and does
not change the recipient's tools or permissions.

## Non-waiting send (Cloud backend)

```typescript
SendAgentMessage({ conversation_id: "conv-…", message: "…" })   // continue a thread
SendAgentMessage({ agent_id: "agent-…", message: "…" })         // open a new hidden thread
SendAgentMessage({ agent_id: "agent-…", conversation_id: "default", message: "…" })  // the agent's default thread
```

Success means Cloud accepted the message (`status: "queued"`), not that the
recipient has read it. Keep working. Omit `computer`: the recipient runs on its
conversation's current computer with its own tools and permissions.

The CLI form behaves the same; use it from scripts or when the tool is absent:

```bash
letta -p --conversation <conversation-id> --no-wait --output-format json "message"
letta -p --agent <agent-id> --no-wait --output-format json "message"
```

## Waiting send (either backend)

```bash
letta -p --from-agent $LETTA_AGENT_ID --agent <agent-id> --output-format json "message"
letta -p --from-agent $LETTA_AGENT_ID --conversation <conversation-id> --output-format json "follow-up"
```

`result` holds the recipient's final message; `conversation_id` is the thread
to continue. `--from-agent` tells the recipient who is asking and makes a new
thread hidden.

If your agent ID starts with `agent-local-`, add `--backend local` so the
command uses the local store: `letta --backend local -p …`. The flag applies to
that command only.

On the Cloud backend the recipient still executes on its own computer; if your
wait times out or is interrupted, the recipient's work continues. On the local
backend the recipient's turn runs inside the `letta -p` process you launched,
so the `--tools`, `--permission-mode`, and working directory you give it apply
to that turn.

## Replying to another agent

A message from another agent arrives with a system reminder naming the
sender's agent and conversation IDs.

- If it says the sender will only see your final message: answer in your
  response. Nothing more is needed.
- If it gives a return address: reply explicitly with
  `SendAgentMessage({ agent_id, conversation_id, message })`, or
  `letta -p --agent <sender-agent-id> --conversation <sender-conversation-id> --no-wait "reply"`.
  Your ordinary output is not forwarded to the sender.

## Finding an agent

```bash
letta agents list --query "name"
letta messages search --query "topic" --all-agents   # results include agent_id
```

Load the `finding-agents` skill for more search options.

## Gotchas

- `SendAgentMessage` may appear in your tool list on any backend, but it and
  `--no-wait` return an error unless the backend is Cloud. Check your agent ID
  prefix first.
- On the Cloud backend, `letta -p --agent <id> "message"` with neither
  `--from-agent` nor `--no-wait` runs that agent's turn inside your own process
  on this computer instead of delivering to the agent's computer. Include one
  of the two.
- Cloud sends reject execution flags (`--tools`, `--permission-mode`, `--model`,
  `--system`, and similar). The recipient runs with its own configuration.
- `letta messages status` is Cloud only. On the local backend, read a thread
  with `letta --backend local messages list --conversation <id>`.
- `--conversation default` needs `--agent`; `default` is scoped to an agent.
- A `computer` selector on a send does not move a conversation that is active
  on another computer; the send is rejected instead. To move a conversation,
  teleport it (see the `working-across-computers` skill).
- A self-hosted Letta server has no computers API and behaves like the local
  backend for the options above.
- A receipt means accepted, not delivered. If a send's outcome is unknown,
  inspect the thread before resending.

## When you need more

Read `references/cli-reference.md` when you need to route a Cloud send to a
specific computer, interpret receipt fields, investigate a send whose
acceptance is unknown, inspect hidden conversations, or see every flag.
`letta --help` lists the rest of the CLI.

To drive a Letta Code instance configured for a different backend, or Claude
Code or Codex, shell out to that CLI the way the `dispatching-coding-agents`
skill describes. Inside it, use the waiting-send commands above with
`--backend` and `--from-agent` values that exist on that backend.
