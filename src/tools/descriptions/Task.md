# Agent

Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Choose a preset or configure the launch yourself:

- `subagent_type` selects a preset from Available Agents (for example `recall`, or a custom agent in `.letta/agents/`). Only `description` and `prompt` are required alongside it. The preset determines the launch settings; all other optional Agent fields are ignored.
- Without `subagent_type`, `harness` selects the runner: `letta` (the default), `claude-code`, `codex`, `cursor`, or `opencode`. The default Letta agent can research, plan, and implement.
- Without `subagent_type`, `fork_context: true` gives the default Letta agent, or an external coding worker, this conversation's history. Otherwise it starts fresh with your prompt.

```typescript
// Default Letta agent
Agent({ description: "Find auth code", prompt: "..." })

// Specialized Letta subagent
Agent({ subagent_type: "recall", description: "Find past decision", prompt: "..." })

// External coding worker
Agent({ harness: "codex", description: "Fix flaky test", prompt: "..." })
```

## When NOT to use the Agent tool:

- To send input to an agent that is already working, use SendAgentMessage when available (Cloud backend). It sends to the existing conversation without waiting for an answer or creating another local task. On the local backend, or for other ways to message an agent, load the messaging-agents skill.
- If you want to read a specific file path, use the Read or Glob tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

## Usage notes:

- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you along with its conversation ID. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Agents always run in the background. The tool result includes a task ID and an output_file path. You are notified with a <task-notification> when the agent finishes, so don't poll just to wait; keep working.
- To check on a running agent of any type, Read its output file. It logs each tool call (`tool:`), its outcome (`result: ok, 3.2 KB`, or `result: error, …` with the line naming the error), and each message (`text:`) as they happen, with timestamps, and ends with `[Task completed]` or `[Task failed]`. To get each step as an event, arm a Monitor on `tail -f` of the file. A tool call writes nothing until it returns, so a quiet log under a long-running `tool:` line usually means busy, not stuck; don't call an agent stalled or dead from a quiet log alone.
- For exact details, such as which test failed and its error, a file's contents, or a command's full output, read the event log next to the output file (the `Event log:` path in the tool result, `<task>.jsonl`). It has one JSON object per line, in order and untruncated: `tool_call` (`id`, `name`, `input`), `tool_result` (`tool_call_id`, `name`, `is_error`, `output`), `text`, `reasoning`, and `notification` (a background command's completion notice, with its output). Search it with Grep or `jq` instead of reading it whole when it is large. For a Letta subagent, `letta messages list --agent <agent_id> --conversation <conversation_id>` reads its full conversation, including turns after this task.
- Agents can be resumed using the `conversation_id` parameter by passing the conversation ID from a previous invocation. When resumed, the agent continues with its full previous context preserved.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- Make each subtask concrete, well defined, and self-contained: what to do, where, and what a finished result looks like.
- Point the agent at the repository and file paths to read rather than passing your own summary of them. An agent on this machine shares your filesystem, so make sure the checkout exists before you launch it. An agent on another machine or a fresh Cloud sandbox starts empty, so tell it what to clone.
- A forked agent sees the full conversation history before the tool call, so you can write concise prompts that reference earlier context (e.g., "investigate the error discussed above") instead of repeating information. Presets determine whether they fork; otherwise use `fork_context: true`.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch multiple agents in parallel, send a single message with multiple Agent tool calls.

## External Coding Agents

Omit `subagent_type` and use `harness: "claude-code"`, `"codex"`, `"cursor"`, or `"opencode"` to start that external coding worker in the selected checkout. These workers execute shell commands and edits without per-tool Letta approvals; only delegate work you authorize them to perform. They use the same background task lifecycle and completion notifications as Letta subagents, but do not create Letta agents or conversations. Do not combine them with `agent_id` or `conversation_id`. With `fork_context: true`, the latest complete messages up to 50,000 characters are included in the prompt; older messages are saved without tool-output clipping under `.letta/parent-transcripts/` on the worker's execution host. Reasoning and system messages are omitted. When `model` is omitted, each worker uses its own CLI's default model; a new `cursor` session requires a Cursor model ID. Discover native model IDs with `letta model list --worker [claude-code|codex|opencode|cursor]`.

```typescript
Agent({
  harness: "codex",
  description: "Fix flaky test",
  prompt: "Make src/utils/retry.test.ts pass reliably. Run it ten times to confirm.",
})
```

Use the receipt's `agent_id` with `SendAgentMessage` to message active work or start a tracked follow-up, and its `task_id` with `TaskStop` to stop it.

Fresh Letta subagents automatically discover and call the parent's MCP servers through `letta mcp`. This includes local and cloud-attached servers without copying connections or credentials. Deploying an existing agent keeps that agent's MCP scope.

External coding workers automatically receive the parent's MCP discovery metadata and use the same `letta mcp` CLI through their shell. To advertise a subset:

```typescript
Agent({
  harness: "claude-code",
  description: "Inspect Linear issue",
  prompt: "Read the issue and trace the relevant implementation.",
  mcp: {
    inherit: true,
    servers: ["linear"],
  },
})
```

Omitting `mcp` advertises every MCP server currently available to the parent. `mcp: { inherit: false }` omits the discovery reminder. Adding `servers` advertises exactly that named subset and fails before launch if a requested server is unavailable. These options control discovery, not authorization or a security allowlist.

## Deploying an Existing Agent

Instead of spawning a fresh subagent from a template, you can deploy an existing agent to work in your local codebase.

### Access Levels

When deploying an existing agent, use the default harness `letta` and omit `subagent_type`: the agent keeps its own system prompt and memory, with full read-write access (Bash, Edit, Write, etc.) for implementation and research tasks. `fork_context` cannot be combined with `agent_id` or `conversation_id`.

### Parameters

- **agent_id**: The ID of an existing agent to deploy (e.g., "agent-abc123")
  - Starts a new conversation with that agent
  - The agent keeps its own system prompt and memory

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
  description: "Find authentication code",
  prompt: "Search for all authentication-related code in src/. List file paths and the main auth approach used."
})

// Good - complex multi-step task
Agent({
  description: "Add input validation",
  prompt: "Add email and password validation to the user registration form. Check existing validation patterns first, then implement consistent validation."
})

// Parallel execution - launch both at once in a single message
Agent({ description: "Find frontend components", prompt: "..." })
Agent({ description: "Find backend APIs", prompt: "..." })

// Bad - too simple, use Read tool instead
Agent({
  prompt: "Read src/index.ts"
})
```

## Forking Parent Context

Omit `subagent_type` and set `fork_context: true` to start the default Letta agent with this conversation's full history. It runs against a forked copy of the current conversation, so it has all accumulated context without you serializing it into the prompt.

This is useful when:
- The agent needs deep context that would be expensive to re-explain in the prompt
- You want to leverage prompt caching across multiple parallel forked agents
- The task requires understanding decisions and discussion from earlier in the conversation

```typescript
// Fork with full parent context
Agent({
  fork_context: true,
  description: "Implement auth module",
  prompt: "Implement the auth module we discussed. Use the patterns from the existing code."
})

// Parallel forks share the same cached prefix
Agent({ fork_context: true, description: "Implement component A", prompt: "..." })
Agent({ fork_context: true, description: "Implement component B", prompt: "..." })
```

Presets ignore `fork_context` and use their configured context; `recall` always sees the conversation. Without a preset, `fork_context: true` cannot be combined with `agent_id` or `conversation_id`.

## Specialized Letta Subagents

Pass `subagent_type`, `description`, and `prompt` to use a preset's settings. Any other optional Agent fields are ignored:

```typescript
// Search earlier conversation history (read-only)
Agent({
  subagent_type: "recall",
  description: "Find past decision",
  prompt: "Find where we decided how retries should back off, and quote the reasoning."
})
```

## Running on Another Computer

Without `subagent_type`, pass `computer` to run the subagent's turn on another connected computer instead of this machine. Prefer a stable device ID or computer name; these select the freshest online listener for that device. Ephemeral connection IDs are still supported to pin a specific listener. The call fails fast if the named device is offline, the name matches multiple online devices, or the listener is too old to support routing.

`computer: "cloud"` provisions a Cloud sandbox for the subagent's conversation and runs the turn there. Sandboxes are per-conversation: this is a separate machine from wherever you are running now, even if you are already in a Cloud sandbox.

External coding workers also accept `computer`: the worker runs on that connected computer using its checkout, installed runtime, and credentials. With `fork_context: true`, the destination prepares the preview and older-history file before launching the worker, including in a Cloud sandbox. A remote host must support destination-local history files or the launch fails. If the required runtime or credentials are unavailable there, don't run it on this machine instead.

`computer: "direct:<name>"` reaches a computer configured with `letta computers add-direct` over its own App Server connection, without Letta Cloud. It runs external coding workers only (set `harness`), and the worker does not inherit your MCP servers unless you pass `mcp`.

Omit `computer` to run the subagent on the current machine. That is the default and the right choice for almost all tasks — the subagent shares your working directory and files. Only set `computer` when the task specifically needs another machine (its files, its OS, or an isolated sandbox).

Some hosts set a default so that subagents launched without a `computer` run elsewhere — on those, omitting `computer` does not mean this machine. Pass `computer: "local"` to pin a subagent to the current machine regardless of that default. Forked agents (`fork_context: true`) and `recall` ignore the default and always start here, because their inherited context describes this machine's files.

```typescript
// Fork this conversation and run the work on a connected computer
Agent({
  fork_context: true,
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
- The remote turn's tool calls, results, and messages reach the output file and event log within a few seconds, as for a local run. Its final assistant message is returned as the task result. Token and step statistics are not available for remote runs.
- Computer-routed tasks are submitted asynchronously and tracked through Cloud's existing Super Run status feed. Temporary status-read failures retry in the background; there is no one-hour tracking ceiling. Completion still notifies you if the reply could not be collected; use `letta messages list` to read the conversation rather than launching the task again. Stopping a task cancels its queued input or its executing listener run.

## Concurrency and Safety:

- **Safe**: Multiple read-only agents (e.g. recall) running in parallel
- **Safe**: Multiple agents editing different files in parallel
- **Risky**: Multiple agents editing the same file (conflict detection will handle it, but may lose changes)
- **Best practice**: Partition work by file or directory boundaries for parallel execution
