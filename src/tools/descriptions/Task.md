# Agent

Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized subagents that autonomously handle complex tasks. Each subagent type has specific capabilities and tools available to it.

When using the Agent tool, you must specify a subagent_type parameter to select which agent type to use.

## When NOT to use the Agent tool:

- To send input to an agent that is already working, use SendAgentMessage when available (Cloud backend). It sends to the existing conversation without waiting for an answer or creating another local task. On the local backend, or for other ways to message an agent, load the messaging-agents skill.
- If you want to read a specific file path, use the Read or Glob tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

## Usage notes:

- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- Except for silent memory tasks, when the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Agents always run in the background. The tool result includes a task ID and an output_file path, and except for silent memory tasks, you will be notified automatically via a <task-notification> message when it completes, so there is no need to poll. The output file receives the report when the agent finishes; it has no interim progress. You can continue working while agents run.
- Agents can be resumed using the `conversation_id` parameter by passing the conversation ID from a previous invocation. When resumed, the agent continues with its full previous context preserved.
- Except for silent memory tasks, when the agent is done, it will return a single message back to you along with its conversation ID. You can use this ID to resume the agent later if needed for follow-up work.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- Agents with "access to current context" can see the full conversation history before the tool call. When using these agents, you can write concise prompts that reference earlier context (e.g., "investigate the error discussed above") instead of repeating information. The agent will receive all prior messages and understand the context.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch multiple agents in parallel, send a single message with multiple Agent tool calls.

## Reasoning Effort

Pass `reasoning_effort` to choose how hard the agent thinks, independently of which model it runs on: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `none` means no reasoning at all; `minimal` through `max` turn it up.

Some model IDs already encode an effort (for example `sonnet-5-low`). An explicit `reasoning_effort` overrides that. Omit the field to keep whatever the model ID implies, which is the existing behavior.

`reasoning_effort` may be used on its own, without `model`, to run the same model at a different effort. It is ignored when deploying an existing agent with `agent_id` or `conversation_id`, because that agent keeps its own model settings.

Whether a given model supports a given effort is up to the provider; an unsupported combination surfaces as a provider error rather than being rejected locally.

```typescript
// Same model, more effort
Agent({
  subagent_type: "general-purpose",
  reasoning_effort: "high",
  description: "Design the migration",
  prompt: "..."
})

// Model and effort chosen independently
Agent({
  subagent_type: "general-purpose",
  model: "opus-5",
  reasoning_effort: "low",
  description: "Apply the rename",
  prompt: "..."
})
```

## Deploying an Existing Agent

Instead of spawning a fresh subagent from a template, you can deploy an existing agent to work in your local codebase.

### Access Levels (subagent_type)

When deploying an existing agent, only `general-purpose` is supported: full read-write access (Bash, Edit, Write, etc.) for implementation and research tasks. If `subagent_type` is not specified, it defaults to `"general-purpose"`.

### Parameters

- **agent_id**: The ID of an existing agent to deploy (e.g., "agent-abc123")
  - Starts a new conversation with that agent
  - The agent keeps its own system prompt and memory
  - Tool access is controlled by subagent_type

- **conversation_id**: Resume from an existing conversation (e.g., "conv-xyz789")
  - Normal `conv-...` IDs are globally unique and do not require `agent_id`
  - If a prior invocation returns the conversation ID `default`, pass both that invocation's `agent_id` and `conversation_id: "default"`; `default` is agent-scoped and cannot identify an agent by itself
  - Continues from the conversation's existing message history
  - Use this to continue context from:
    - A prior Agent tool invocation that returned a conversation_id
    - A message thread started via the messaging-agents skill

### Examples

```typescript
// Deploy an existing agent
Agent({
  agent_id: "agent-abc123",
  subagent_type: "general-purpose",
  description: "Fix auth bug",
  prompt: "Fix the bug in auth.ts"
})

// Continue an existing conversation
Agent({
  conversation_id: "conv-xyz789",
  description: "Continue implementation",
  prompt: "Now implement the fix we discussed"
})

// Continue an agent's default conversation
Agent({
  agent_id: "agent-abc123",
  conversation_id: "default",
  description: "Continue implementation",
  prompt: "Now implement the fix we discussed"
})
```

## Example usage:

```typescript
// Good - specific and actionable
Agent({
  subagent_type: "general-purpose",
  description: "Find authentication code",
  prompt: "Search for all authentication-related code in src/. List file paths and the main auth approach used."
})

// Good - complex multi-step task
Agent({
  subagent_type: "general-purpose",
  description: "Add input validation",
  prompt: "Add email and password validation to the user registration form. Check existing validation patterns first, then implement consistent validation."
})

// Parallel execution - launch both at once in a single message
Agent({ subagent_type: "general-purpose", description: "Find frontend components", prompt: "..." })
Agent({ subagent_type: "general-purpose", description: "Find backend APIs", prompt: "..." })

// Bad - too simple, use Read tool instead
Agent({
  subagent_type: "general-purpose",
  prompt: "Read src/index.ts"
})
```

## Forking Parent Context

Use `subagent_type: "fork"` to launch a subagent that inherits the parent's full conversation history. The subagent runs against a forked copy of the current conversation, so it has all accumulated context without the parent needing to serialize it into the prompt.

This is useful when:
- The subagent needs deep context that would be expensive to re-explain in the prompt
- You want to leverage prompt caching across multiple parallel forked subagents
- The task requires understanding decisions and discussion from earlier in the conversation

```typescript
// Fork with full parent context
Agent({
  subagent_type: "fork",
  description: "Implement auth module",
  prompt: "Implement the auth module we discussed. Use the patterns from the existing code."
})

// Parallel forks share the same cached prefix
Agent({ subagent_type: "fork", description: "Implement component A", prompt: "..." })
Agent({ subagent_type: "fork", description: "Implement component B", prompt: "..." })
```

Note: `fork` cannot be combined with `agent_id` or `conversation_id`.

## Running on Another Computer

Pass `computer` to run the subagent's turn on another connected computer instead of this machine. Prefer a stable device ID or computer name; these select the freshest online listener for that device. Ephemeral connection IDs are still supported to pin a specific listener. Memory workers must run on the current machine; do not set `computer` for `subagent_type: "memory"`. The call fails fast if the named device is offline, the name matches multiple online devices, or the listener is too old to support routing.

`computer: "cloud"` provisions a Cloud sandbox for the subagent's conversation and runs the turn there. Sandboxes are per-conversation: this is a separate machine from wherever you are running now, even if you are already in a Cloud sandbox.

Omit `computer` to run the subagent on the current machine. That is the default and the right choice for almost all tasks — the subagent shares your working directory and files. Only set `computer` when the task specifically needs another machine (its files, its OS, or an isolated sandbox).

```typescript
// Fork this conversation and run the work on a connected computer
Agent({
  subagent_type: "fork",
  computer: "office-mac",
  description: "Run integration tests",
  prompt: "Run the integration suite in the checkout on this machine and report failures."
})

// Deploy an existing agent into a fresh Cloud sandbox
Agent({
  agent_id: "agent-abc123",
  computer: "cloud",
  description: "Build release artifacts",
  prompt: "Build and upload the release artifacts."
})
```

Behavior notes:
- The remote turn runs with the remote machine's working directory, tools, and skills. Subagent-type tool restrictions (e.g. recall's read-only toolset) travel with the turn on current servers; older servers ignore them.
- The remote turn's final assistant message is returned as the task result. Token and step statistics are not available for remote runs.
- Computer-routed tasks are submitted asynchronously and tracked through Cloud's existing Super Run status feed. Temporary status-read failures retry in the background; there is no one-hour tracking ceiling. Completion still notifies you if the reply could not be collected; use `letta messages list` to read the conversation rather than launching the task again. Stopping a task cancels its queued input or its executing listener run.

## Concurrency and Safety:

- **Safe**: Multiple read-only agents (e.g. recall, history-analyzer) running in parallel
- **Safe**: Multiple agents editing different files in parallel
- **Risky**: Multiple agents editing the same file (conflict detection will handle it, but may lose changes)
- **Best practice**: Partition work by file or directory boundaries for parallel execution

Use memory subagents (`subagent_type: "memory"`) for incidental memory upkeep while working on another task. When memory itself is the user's main request, handle it directly with ordinary file tools and shell/Git commands, and verify completion.

Memory subagents start fresh and silently edit or repair memory in the background. Include all necessary facts, corrections, and exceptions in the assignment, quoting factual corrections and exceptions verbatim rather than broadening their scope. The parent transcript is available only as a reference if needed. Continue immediately after incidental delegation; they do not send completion notifications. Do not wait or poll while working on another task. Workers edit a private worktree that the harness merges into memory when they finish, so your own direct edits do not collide with them; if memory becomes the main task while a worker you launched may still be running, read its output file first (it ends with `[Task completed]` or `[Task failed]`) and reread the memory files before editing what it was asked to change.
