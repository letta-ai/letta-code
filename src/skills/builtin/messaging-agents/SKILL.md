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

**Need local access?** If you need the target agent to access your local environment (read/write files, run commands), use the Task tool instead to deploy them as a subagent:
```typescript
Task({
  agent_id: "agent-xxx",           // Deploy this existing agent
  subagent_type: "explore",        // "explore" = read-only, "general-purpose" = read-write
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
Load the `searching-messages` skill to find which agent worked on something:
```bash
letta messages search --query "topic" --all-agents
```
Results include `agent_id` for each matching message.

## CLI Usage (agent-to-agent)

### Starting a New Conversation

```bash
letta -p --from-agent $LETTA_AGENT_ID --agent <id> "message text"
```

**Arguments:**
| Arg | Required | Description |
|-----|----------|-------------|
| `--agent <id>` | Yes | Target agent ID to message |
| `--from-agent <id>` | Yes | Sender agent ID (injects agent-to-agent system reminder) |
| `"message text"` | Yes | Message body (positional after flags) |

**Example:**
```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --agent agent-abc123 \
  "What do you know about the authentication system?"
```

**Response:**
```json
{
  "conversation_id": "conversation-xyz789",
  "response": "The authentication system uses JWT tokens...",
  "agent_id": "agent-abc123",
  "agent_name": "BackendExpert"
}
```

### Continuing a Conversation

```bash
letta -p --from-agent $LETTA_AGENT_ID --conversation <id> "message text"
```

**Arguments:**
| Arg | Required | Description |
|-----|----------|-------------|
| `--conversation <id>` | Yes | Existing conversation ID |
| `--from-agent <id>` | Yes | Sender agent ID (injects agent-to-agent system reminder) |
| `"message text"` | Yes | Follow-up message (positional after flags) |

**Example:**
```bash
letta -p --from-agent $LETTA_AGENT_ID \
  --conversation conversation-xyz789 \
  "Can you explain more about the token refresh flow?"
```

## Understanding the Response

- Scripts return only the **final assistant message** (not tool calls or reasoning)
- The target agent may use tools, think, and reason - but you only see their final response
- To see the full conversation transcript (including tool calls), use the `searching-messages` skill with `letta messages list --agent <id>` targeting the other agent

## How It Works

When you send a message, the target agent receives it with a system reminder:
```
<system-reminder>
This message is from "YourAgentName" (agent ID: agent-xxx), an agent currently running inside the Letta Code CLI (docs.letta.com/letta-code).
The sender will only see the final message you generate (not tool calls or reasoning).
If you need to share detailed information, include it in your response text.
</system-reminder>
```

This helps the target agent understand the context and format their response appropriately.

## Related Skills

- **finding-agents**: Find agents by name, tags, or fuzzy search
- **searching-messages**: Search past messages across agents, or view full conversation transcripts
