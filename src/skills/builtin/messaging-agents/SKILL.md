---
name: messaging-agents
description: Send messages to other agents on your server. Use when you need to communicate with, query, or delegate tasks to another agent.
---

# Messaging Agents

This skill enables you to send messages to other agents on the same Letta server using the thread-safe conversations API.

## When to Use This Skill

- You need to ask another agent a question
- You want to query an agent that has specialized knowledge
- You need information that another agent has in their memory
- You want to coordinate with another agent on a task

## What the Target Agent Can and Cannot Do

**The target agent CANNOT:**
- Access your local environment (read/write files in your codebase)
- Execute shell commands on your machine
- Use your tools (Bash, Read, Write, Edit, etc.)

**The target agent CAN:**
- Use their own tools (whatever they have configured)
- Access their own memory blocks
- Make API calls if they have web/API tools
- Search the web if they have web search tools
- Respond with information from their knowledge/memory

**Important:** This skill is for *communication* with other agents, not *delegation* of local work. The target agent runs in their own environment and cannot interact with your codebase.

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

## CLI Usage (agent-to-agent)

### Send without waiting for the answer (Cloud)

```bash
letta -p --conversation <target-conversation-id> --no-wait --output-format json "message text"
```

Keep the returned receipt. `queued` confirms Cloud accepted the message, not that
the recipient has read it or finished. The CLI uses your `AGENT_ID` and
`CONVERSATION_ID` as the return address. Reply explicitly to the supplied address;
ordinary assistant output is not forwarded for a non-waiting send.

To inspect progress without a local task ID, use the receipt's `status_command`
or `messages_command`:

```bash
letta messages status --agent <target-agent-id> --conversation <target-conversation-id>
letta messages list --agent <target-agent-id> --conversation <target-conversation-id>
```

Compare `latest_super_run.id` with the receipt's `super_run_id`. A different ID
belongs to another send; an idle conversation alone does not prove completion.
If waiting fails or times out, inspect before resending. The CLI does not cancel
remote work when it stops waiting.

Omit `--no-wait` to wait for the final answer instead. Configure execution tools
and permissions on the recipient; Cloud sends do not accept local execution
flags such as `--tools` or `--permission-mode`.

### Starting a New Conversation

```bash
letta -p --from-agent $LETTA_AGENT_ID --agent <id> "message text"
```

For Cloud agents, omitting `--computer` lets Cloud select the conversation's
active or saved computer, or start a Cloud sandbox when needed. Local/App Server
execution and Agent-launched child processes keep their existing behavior.

To route the target agent turn through a specific remote/local computer:

```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --agent <id> \
  --computer <name-or-device-id-or-connection-id> \
  "message text"
```

Use `--computer cloud` to route through the target agent's cloud sandbox:

```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --agent <id> \
  --computer cloud \
  "message text"
```

**Arguments:**
| Arg | Required | Description |
|-----|----------|-------------|
| `--agent <id>` | Yes | Target agent ID to message |
| `--from-agent <id>` | Yes, unless using `--no-wait` | Select agent-to-agent delivery when starting a conversation |
| `--computer <selector>` | No | Route through `cloud` (target agent's cloud sandbox) or an online computer by connection name, device ID, or connection ID |
| `"message text"` | Yes | Message body (positional after flags) |

**Example:**
```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --agent agent-abc123 \
  "What do you know about the authentication system?"
```

**Response (JSON format with `--output-format json`, relevant fields):**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "The authentication system uses JWT tokens...",
  "agent_id": "agent-abc123",
  "conversation_id": "conv-xyz789",
  "status": "completed",
  "usage": null
}
```

### Continuing a Conversation

```bash
letta -p --from-agent $LETTA_AGENT_ID --conversation <id> "message text"
```

Add `--computer <selector>` to continue the conversation on a specific computer.

### Discovering Computers

```bash
letta computers list --online-only
# alias:
letta envs list --online-only
```

Use `connectionName`, `deviceId`, or `connectionId` from the JSON output as the
`--computer` selector. If a name is ambiguous, prefer `deviceId` or
`connectionId`. In `computers list`, the current local runtime is marked with
`"isCurrent": true`.

To force the target agent onto the current registered Letta Code computer,
resolve the current computer and pass its `connectionId`:

```bash
CURRENT_COMPUTER=$(letta computers current | jq -r .connectionId)
letta -p --from-agent $LETTA_AGENT_ID \
  --agent agent-abc123 \
  --computer "$CURRENT_COMPUTER" \
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
  --conversation conversation-xyz789 \
  "Can you explain more about the token refresh flow?"
```

## Understanding the Response

- Text-mode scripts return only the **final assistant message** (not tool calls, reasoning, or metadata)
- Cloud enqueue receipts include `agent_id`, `conversation_id`, `client_message_id`, `workflow_id`, and `super_run_id`. Waiting JSON results retain these IDs and add the answer and associated `run_ids`.
- The target agent may use tools, think, and reason - but you only see their final response
- To see the full conversation transcript (including tool calls), use `letta messages list --agent <id>` targeting the other agent

## How It Works

When you send a message, the target agent receives it with a system reminder:
```
<system-reminder>
This message is from agent agent-xxx, conversation conv-xxx.
The sender will only see the final message you generate (not tool calls or reasoning). Include your answer in your final response.
</system-reminder>
```

This helps the target agent understand the context and format their response appropriately.

## Hidden Conversations

Agent-to-agent conversations (started via `--from-agent`) are created **hidden** on the target agent. They don't appear in the target's default conversation list in the ADE, so automated inter-agent chatter doesn't clutter the UI.

To inspect them:
- List hidden conversations via the API with `archive_status=archived` (or `all`)
- Pull the transcript directly with `letta messages transcript --conversation <id>`
- The `conversation_id` returned when you sent the message is the handle you need

Continuing a hidden conversation with `--conversation <id>` keeps it hidden — only archive status is affected, messaging still works normally.

## Related Skills

- **finding-agents**: Find agents by name, tags, or fuzzy search
