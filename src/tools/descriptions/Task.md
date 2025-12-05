# Task

Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are defined in `.letta/agents/` as Markdown files. The agent descriptions below are dynamically loaded from those files.

## Usage

When using the Task tool, you must specify:
- **subagent_type**: Which specialized agent to use (see Available Agents section)
- **prompt**: Detailed, self-contained instructions for the agent (agents cannot ask questions mid-execution)
- **description**: Short 3-5 word summary for tracking
- **model** (optional): Override the model for this agent

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
