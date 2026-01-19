# Task

Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

## Usage

The Task tool supports two commands:

### Run (default)
Launch a subagent to perform a task. Parameters:
- **subagent_type**: Which specialized agent to use (see Available Agents section)
- **prompt**: Detailed, self-contained instructions for the agent (agents cannot ask questions mid-execution)
- **description**: Short 3-5 word summary for tracking
- **model** (optional): Override the model for this agent
- **agent_id** (optional): Deploy an existing agent instead of creating a new one
- **conversation_id** (optional): Resume from an existing conversation

### Refresh
Re-scan the `.letta/agents/` directories to discover new or updated custom subagents:
```typescript
Task({ command: "refresh" })
```
Use this after creating or modifying custom subagent definitions.

## When to use this tool:

- **Codebase exploration**: Use when you need to search for files, understand code structure, or find specific patterns
- **Complex tasks**: Use when a task requires multiple steps and autonomous decision-making
- **Research tasks**: Use when you need to gather information from the codebase
- **Parallel work**: Launch multiple agents concurrently for independent tasks

## When NOT to use this tool:

- If you need to read a specific file path, use Read tool directly
- If you're searching for a specific class definition, use Glob tool directly
- If you're searching within 2-3 specific files, use Read tool directly
- For simple, single-step operations

## Important notes:

- **Stateless**: Each agent invocation is autonomous and returns a single final report
- **No back-and-forth**: You cannot communicate with agents during execution
- **Front-load instructions**: Provide complete task details upfront
- **Context-aware**: Agents see full conversation history and can reference earlier context
- **Parallel execution**: Launch multiple agents concurrently by calling Task multiple times in a single response
- **Specify return format**: Tell agents exactly what information to include in their report

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

## Examples:

```typescript
// Good - specific and actionable with a user-specified model "gpt-5-low"
Task({
  subagent_type: "explore",
  description: "Find authentication code",
  prompt: "Search for all authentication-related code in src/. List file paths and the main auth approach used.",
  model: "gpt-5-low"
})

// Good - complex multi-step task
Task({
  subagent_type: "general-purpose",
  description: "Add input validation",
  prompt: "Add email and password validation to the user registration form. Check existing validation patterns first, then implement consistent validation."
})

// Parallel execution - launch both at once
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
