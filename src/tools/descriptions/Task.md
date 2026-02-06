# Task

Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

## When NOT to use the Task tool:

- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

## Usage notes:

- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, the tool result will include an output_file path. To check on the agent's progress or retrieve its results, use the Read tool to read the output file, or use Bash with `tail` to see recent output. You can continue working while background agents run.
- Agents can be resumed using the `conversation_id` parameter by passing the conversation ID from a previous invocation. When resumed, the agent continues with its full previous context preserved.
- When the agent is done, it will return a single message back to you along with its conversation ID. You can use this ID to resume the agent later if needed for follow-up work.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- Agents with "access to current context" can see the full conversation history before the tool call. When using these agents, you can write concise prompts that reference earlier context (e.g., "investigate the error discussed above") instead of repeating information. The agent will receive all prior messages and understand the context.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Task tool use content blocks. For example, if you need to launch multiple agents in parallel, send a single message with multiple Task tool calls.

## Deploying an Existing Agent

Instead of spawning a fresh subagent from a template, you can deploy an existing agent to work in your local codebase.

### Access Levels (subagent_type)

Use subagent_type to control what tools the deployed agent can access:
- **explore**: Read-only access (Read, Glob, Grep) - safer for exploration tasks
- **general-purpose**: Full read-write access (Bash, Edit, Write, etc.) - for implementation tasks

If subagent_type is not specified when deploying an existing agent, it defaults to "general-purpose".

### Parameters

- **agent_id**: The ID of an existing agent to deploy (e.g., "agent-abc123")
  - Starts a new conversation with that agent
  - The agent keeps its own system prompt and memory
  - Tool access is controlled by subagent_type

- **conversation_id**: Resume from an existing conversation (e.g., "conv-xyz789")
  - Does NOT require agent_id (conversation IDs are unique and encode the agent)
  - Continues from the conversation's existing message history
  - Use this to continue context from:
    - A prior Task tool invocation that returned a conversation_id
    - A message thread started via the messaging-agents skill

### Examples

```typescript
// Deploy agent with read-only access
Task({
  agent_id: "agent-abc123",
  subagent_type: "explore",
  description: "Find auth code",
  prompt: "Find all auth-related code in this codebase"
})

// Deploy agent with full access (default)
Task({
  agent_id: "agent-abc123",
  subagent_type: "general-purpose",
  description: "Fix auth bug",
  prompt: "Fix the bug in auth.ts"
})

// Continue an existing conversation
Task({
  conversation_id: "conv-xyz789",
  description: "Continue implementation",
  prompt: "Now implement the fix we discussed"
})
```

## Example usage:

```typescript
// Good - specific and actionable
Task({
  subagent_type: "explore",
  description: "Find authentication code",
  prompt: "Search for all authentication-related code in src/. List file paths and the main auth approach used."
})

// Good - complex multi-step task
Task({
  subagent_type: "general-purpose",
  description: "Add input validation",
  prompt: "Add email and password validation to the user registration form. Check existing validation patterns first, then implement consistent validation."
})

// Parallel execution - launch both at once in a single message
Task({ subagent_type: "explore", description: "Find frontend components", prompt: "..." })
Task({ subagent_type: "explore", description: "Find backend APIs", prompt: "..." })

// Bad - too simple, use Read tool instead
Task({
  subagent_type: "explore",
  prompt: "Read src/index.ts"
})
```

## Concurrency and Safety:

- **Safe**: Multiple read-only agents (explore, plan) running in parallel
- **Safe**: Multiple agents editing different files in parallel
- **Risky**: Multiple agents editing the same file (conflict detection will handle it, but may lose changes)
- **Best practice**: Partition work by file or directory boundaries for parallel execution
