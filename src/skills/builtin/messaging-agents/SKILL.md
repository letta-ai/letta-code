---
name: messaging-agents
description: Send messages to other agents on your server. Use when you need to communicate with, query, or delegate tasks to another agent.
---

# Messaging Agents

Use this skill to contact another agent or continue an existing conversation.

An agent has a persistent identity and shared memory. It can have multiple
conversations, each with its own message history. Use a conversation ID to address
an existing thread, or an agent ID to start a new thread with that agent.

For Cloud sends, prefer SendAgentMessage to keep working while the recipient
responds. For local agents, use the local CLI examples below. SendAgentMessage
and `--no-wait` currently require Cloud, even if the tool appears in your tool list.

## When to Use This Skill

- You need to ask another agent a question
- You want to query an agent that has specialized knowledge
- You need information that another agent has in their memory
- You want to coordinate with another agent on a task

## Where the Recipient Runs (Cloud)

Send to the recipient's conversation using its existing tools and permissions.
Omit `computer` to use its active or saved computer, or a Cloud sandbox when needed.
The recipient can access files on that computer, which may differ from yours.

**Need local access?** If you need the target agent to access your local environment (read/write files, run commands), use the Agent tool instead to deploy them as a subagent:
```typescript
Agent({
  agent_id: "agent-xxx",            // Deploy this existing agent
  subagent_type: "general-purpose", // read-write access to your local tools
  prompt: "Look at the code in src/ and tell me about the architecture"
})
```
This gives the agent access to your codebase while running as a subagent.

## Finding an Agent to Message

If you don't have a specific agent ID, use these skills to find one:

### By Name or Tags
Load the `finding-agents` skill to search for agents:
```bash
letta agents list --query "agent-name"
letta agents list --tags "origin:letta-code"
```

### By Topic They Discussed
Search messages across all agents to find which agent worked on something:
```bash
letta messages search --query "topic" --all-agents
```
Results include `agent_id` for each matching message.

## Local CLI

Start a new conversation with an existing local agent:

```bash
letta --backend local -p --from-agent $LETTA_AGENT_ID \
  --agent <target-agent-id> --output-format json "message text"
```

Continue that conversation using the returned `conversation_id`:

```bash
letta --backend local -p --from-agent $LETTA_AGENT_ID \
  --conversation <target-conversation-id> --output-format json "follow-up"
```

Use local agent IDs, including the sender's ID, and the local store containing
those agents. `--backend local` selects the backend for this command without
changing the saved default.

These commands run the recipient's turn in the CLI process, with its working
directory and execution flags. They wait for the answer and print it in the JSON
`result` field. Run the command as a background shell task and collect its output
to keep working meanwhile, or use Agent for a managed child task with completion
notifications. Backgrounding the process does not change the reply into a message
to your conversation.

Do not add `--no-wait` or `--computer` here; both require Cloud. Read local message
history with `letta --backend local messages list --conversation <id>` rather than
the Cloud-only `letta messages status` command.

## SendAgentMessage (Cloud only)

For Cloud agents, use SendAgentMessage to send input without waiting for an answer:

```typescript
SendAgentMessage({
  conversation_id: "conv-target",
  message: "The API change is ready. Please run your integration test.",
})
```

Use `agent_id` alone to start a new hidden conversation. To use an agent's default
thread, supply its `agent_id` and `conversation_id: "default"`.
You can message any conversation you are authorized to access, including an Agent
child that is already working.

Your agent and conversation IDs are attached automatically. To reply, call
SendAgentMessage with the supplied return conversation (and agent ID for `default`).
Ordinary assistant output is not forwarded to the sender.

Successful submission means Cloud accepted the message; the recipient may not have
read it yet. Continue working rather than waiting for an answer. If delivery cannot
be confirmed, check the recipient's messages before resending to avoid duplicates.
The result includes commands for checking activity and reading messages when needed.
Use Agent to launch or resume a managed child task with completion notifications.

## CLI Sends Without Waiting (Cloud only)

Use `--no-wait` for routine Cloud coordination through the CLI. The additional
options below remain available when you need different behavior or diagnostics.

### Send without waiting for the answer (Cloud)

```bash
letta -p --conversation <target-conversation-id> --no-wait --output-format json "message text"
```

Keep the returned receipt. `queued` confirms Cloud accepted the message, not that
the recipient has read it or finished. The CLI uses your `AGENT_ID` and
`CONVERSATION_ID` as the return address. Reply explicitly to the supplied address;
ordinary assistant output is not forwarded for a non-waiting send.

When you need to investigate a send, check activity or read the conversation:

```bash
letta messages status --agent <target-agent-id> --conversation <target-conversation-id>
letta messages list --agent <target-agent-id> --conversation <target-conversation-id>
```

The tool and CLI return these ready-to-run commands in `status_command` and
`messages_command`. A result of `acceptance_unknown` means the request was sent
but acceptance could not be confirmed, for example after a timeout or lost
connection. Inspect before resending because it may already have arrived.

Compare `latest_super_run.id` with the receipt's `super_run_id`. A different ID
belongs to another send; an idle conversation alone does not prove completion.
If waiting fails or times out, inspect before resending. The CLI does not cancel
remote work when it stops waiting.

Configure execution tools and permissions on the recipient; Cloud sends do not
accept local execution flags such as `--tools` or `--permission-mode`.

### Starting a New Conversation

```bash
letta -p --from-agent $LETTA_AGENT_ID --agent <id> --no-wait "message text"
```

Omitting `--computer` lets Cloud select the conversation's active or saved computer,
or start a Cloud sandbox when needed.

To route the target agent turn through a specific remote/local computer:

```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --agent <id> \
  --computer <name-or-device-id> --no-wait \
  "message text"
```

Use `--computer cloud` to route through the target agent's cloud sandbox:

```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --agent <id> \
  --computer cloud --no-wait \
  "message text"
```

**Arguments:**
| Arg | Required | Description |
|-----|----------|-------------|
| `--agent <id>` | Yes | Target agent ID to message |
| `--from-agent <id>` | Yes, unless using `--no-wait` | Select agent-to-agent delivery when starting a conversation |
| `--computer <selector>` | No | Route through `cloud` (target agent's cloud sandbox) or an online computer by name or stable device ID |
| `"message text"` | Yes | Message body (positional after flags) |

**Example:**
```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --agent agent-abc123 \
  --no-wait \
  "What do you know about the authentication system?"
```

**Response (JSON format with `--output-format json`, relevant fields):**
```json
{
  "agent_id": "agent-abc123",
  "conversation_id": "conv-xyz789",
  "status": "queued"
}
```

### Continuing a Conversation

```bash
letta -p --from-agent $LETTA_AGENT_ID --conversation <id> --no-wait "message text"
```

Add `--computer <selector>` to continue the conversation on a specific computer.

### Discovering Computers

```bash
letta computers list --online-only
# alias:
letta envs list --online-only
```

Use `connectionName` or `deviceId` from the JSON output as the `--computer`
selector. If a name is ambiguous, use `deviceId`. A device ID identifies the
registered computer; a connection ID identifies its temporary listener connection.
The CLI also accepts connection IDs and resolves them to the computer, but prefer
the stable device ID. In `computers list`, the current local runtime is marked with
`"isCurrent": true`.

To force the target agent onto the current registered Letta Code computer,
resolve the current computer and pass its `deviceId`:

```bash
CURRENT_COMPUTER=$(letta computers current | jq -r .deviceId)
letta -p --from-agent $LETTA_AGENT_ID \
  --agent agent-abc123 \
  --computer "$CURRENT_COMPUTER" --no-wait \
  "Run on my same computer."
```

Use `--computer` only when that computer is needed. If the conversation is active
on another computer, Cloud returns 409 rather than silently moving it. An offline
computer returns 503. Inspect the error; do not bypass enqueue with a direct send.

**Arguments:**
| Arg | Required | Description |
|-----|----------|-------------|
| `--conversation <id>` | Yes | Existing conversation ID |
| `--from-agent <id>` | No | Override the sender agent ID; otherwise use the calling agent's environment |
| `"message text"` | Yes | Follow-up message (positional after flags) |

**Example:**
```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --conversation conv-xyz789 --no-wait \
  "Can you explain more about the token refresh flow?"
```

## Understanding the Response

- SendAgentMessage and CLI `--no-wait` sends return an acceptance receipt. The recipient replies explicitly to your return conversation. These sends currently require Cloud.
- Cloud enqueue receipts include `agent_id`, `conversation_id`, `client_message_id`, `workflow_id`, and `super_run_id`. Waiting JSON results retain these IDs and add the answer and associated `run_ids`.
- CLI sends without `--no-wait` return the final assistant message through process output, on both Cloud and local backends. Tool calls and reasoning are not included in that answer.
- To see the full conversation transcript (including tool calls), use `letta messages list --agent <id>` targeting the other agent

## How It Works

For a non-waiting send with a return conversation, the target agent receives this
reminder as a separate text part alongside your message:
```
<system-reminder>
This message is from agent agent-xxx, conversation conv-xxx.
To reply to agent agent-xxx, conversation conv-xxx, use SendAgentMessage if available. Otherwise run letta -p --agent agent-xxx --conversation conv-xxx --no-wait "your reply". Ordinary assistant output is not forwarded to the sender.
</system-reminder>
```

This helps the target agent understand the context and format their response appropriately.

## Additional CLI Options

Use `letta --help` to inspect the full CLI when the convenience tool does not fit
your task. For a deliberate synchronous send, such as testing how a script consumes
an answer, omit `--no-wait`:

```bash
letta -p --from-agent $LETTA_AGENT_ID --conversation <target-conversation-id> --output-format json "message text"
```

This waits for the final answer and returns it in `result` on both Cloud and local backends.
The recipient is told to answer in its final response instead of sending a separate
reply. On Cloud, interruption or timeout stops your wait, not the recipient's work;
inspect the conversation before deciding whether to resend. Prefer non-waiting sends
for routine Cloud coordination, or background the local CLI process, so you can keep
working while the recipient responds.

## Hidden Conversations

Agent-to-agent conversations (started via `--from-agent`) are created **hidden** on the target agent. They don't appear in the target's default conversation list in the ADE, so automated inter-agent chatter doesn't clutter the UI.

To inspect them:
- List hidden conversations via the API with `archive_status=archived` (or `all`)
- Pull the transcript directly with `letta messages transcript --conversation <id>`
- The `conversation_id` returned when you sent the message is the handle you need

Continuing a hidden conversation with `--conversation <id>` keeps it hidden — only archive status is affected, messaging still works normally.

## Related Skills

- **finding-agents**: Find agents by name, tags, or fuzzy search
- **dispatching-coding-agents**: Drive Claude Code or Codex through their CLIs, including background execution and collecting results
