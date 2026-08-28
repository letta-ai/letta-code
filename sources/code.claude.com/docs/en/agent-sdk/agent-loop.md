> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# How the agent loop works

> Understand the message lifecycle, tool execution, context window, and architecture that power your SDK agents.

The Agent SDK lets you embed Claude Code's autonomous agent loop in your own applications. The SDK is a standalone package that gives you programmatic control over tools, permissions, cost limits, and output.

Both the TypeScript and Python SDKs bundle a native Claude Code binary, so most installs need no separate Claude Code install. See the [quickstart's install note](/docs/en/agent-sdk/quickstart) for the installs that do.

When you start an agent, the SDK runs the same [execution loop that powers Claude Code](/docs/en/how-claude-code-works#the-agentic-loop): Claude evaluates your prompt, calls tools to take action, receives the results, and repeats until the task is complete. This page explains what happens inside that loop so you can build, debug, and optimize your agents effectively.

## The loop at a glance

Every agent session follows the same cycle:

<img src="https://mintcdn.com/claude-code/ikqp3_70mqIahteV/images/agent-loop-diagram.svg?fit=max&auto=format&n=ikqp3_70mqIahteV&q=85&s=1c6e8f28d80dba14a7287419656f1237" className="dark:hidden" alt="Diagram of the agent loop: your prompt enters the agentic loop, where Claude evaluates and either requests tool calls, whose results feed back into another evaluation, or returns the final answer" width="720" height="212" data-path="images/agent-loop-diagram.svg" />

<img src="https://mintcdn.com/claude-code/_xqph1dUOslCOwsj/images/agent-loop-diagram-dark.svg?fit=max&auto=format&n=_xqph1dUOslCOwsj&q=85&s=afe723c52a324d3c61fa72fb02432ab6" className="hidden dark:block" alt="Diagram of the agent loop: your prompt enters the agentic loop, where Claude evaluates and either requests tool calls, whose results feed back into another evaluation, or returns the final answer" width="720" height="212" data-path="images/agent-loop-diagram-dark.svg" />

1. **Receive prompt.** Claude receives your prompt, along with the system prompt, tool definitions, and conversation history. The SDK yields a [`SystemMessage`](#message-types) with subtype `"init"` containing session metadata.
2. **Evaluate and respond.** Claude evaluates the current state and determines how to proceed. It may respond with text, request one or more tool calls, or both. The SDK yields an [`AssistantMessage`](#message-types) containing the text and any tool call requests.
3. **Execute tools.** The SDK runs each requested tool and collects the results. Each set of tool results feeds back to Claude for the next decision. You can use [hooks](/docs/en/agent-sdk/hooks) to intercept, modify, or block tool calls before they run.
4. **Repeat.** Steps 2 and 3 repeat as a cycle. Each full cycle is one turn. Claude continues calling tools and processing results until it produces a response with no tool calls.
5. **Return result.** The SDK yields a final [`AssistantMessage`](#message-types) with the text response (no tool calls), followed by a [`ResultMessage`](#message-types) with the final text, token usage, cost, and session ID.

A quick question ("what files are here?") might take one or two turns of calling `Glob` and responding with the results. A complex task ("refactor the auth module and update the tests") can chain dozens of tool calls across many turns, reading files, editing code, and running tests, with Claude adjusting its approach based on each result.

## Turns and messages

A turn is one round trip inside the loop: Claude produces output that includes tool calls, the SDK executes those tools, and the results feed back to Claude automatically. This happens without yielding control back to your code. Turns continue until Claude produces output with no tool calls, at which point the loop ends and the final result is delivered.

Consider what a full session might look like for the prompt "Fix the failing tests in auth.ts".

First, the SDK sends your prompt to Claude and yields a [`SystemMessage`](#message-types) with the session metadata. Then the loop begins:

1. **Turn 1:** Claude calls `Bash` to run `npm test`. The SDK yields an [`AssistantMessage`](#message-types) with the tool call, executes the command, then yields a [`UserMessage`](#message-types) with the output (three failures).
2. **Turn 2:** Claude calls `Read` on `auth.ts` and `auth.test.ts`. The SDK returns the file contents and yields an `AssistantMessage`.
3. **Turn 3:** Claude calls `Edit` to fix `auth.ts`, then calls `Bash` to re-run `npm test`. All three tests pass. The SDK yields an `AssistantMessage`.
4. **Final turn:** Claude produces a text-only response with no tool calls: "Fixed the auth bug, all three tests pass now." The SDK yields a final `AssistantMessage` with this text, then a [`ResultMessage`](#message-types) with the same text plus cost and usage.

That was four turns: three with tool calls, one final text-only response.

You can cap the loop with `max_turns` / `maxTurns`, which counts tool-use turns only. For example, `max_turns=2` in the loop above would have stopped before the edit step. You can also use `max_budget_usd` / `maxBudgetUsd` to cap turns based on a spend threshold.

Without limits, the loop runs until Claude finishes on its own, which is fine for well-scoped tasks but can run long on open-ended prompts ("improve this codebase"). Setting a budget is a good default for production agents. See [Turns and budget](#turns-and-budget) below for the option reference.

## Message types

As the loop runs, the SDK yields a stream of messages. Each message carries a type that tells you what stage of the loop it came from. The five core types are:

* **`SystemMessage`:** session lifecycle events. The `subtype` field distinguishes them:

  * `"init"`: session metadata for the run. When a `SessionStart` or `Setup` hook runs during session startup, its [hook lifecycle messages](/docs/en/agent-sdk/typescript#sdkhookstartedmessage) arrive before the `init` message
  * `"compact_boundary"`: fires after [compaction](#automatic-compaction)
  * `"informational"`: plain-text status banners from the loop
  * `"worker_shutting_down"`: the loop will end after the current turn because the host is exiting or Remote Control disconnected

  In TypeScript, each subtype other than `"init"` is its own type in the [`SDKMessage` union](/docs/en/agent-sdk/typescript#sdkmessage) rather than a subtype of `SDKSystemMessage`.
* **`AssistantMessage`:** emitted after each Claude response, including the final text-only one. Contains text content blocks and tool call blocks from that turn.
* **`UserMessage`:** emitted after each tool execution with the tool result content sent back to Claude. Also emitted for any user inputs you stream mid-loop.
* **`StreamEvent`:** only emitted when partial messages are enabled. Contains raw API streaming events (text deltas, tool input chunks). See [Stream responses](/docs/en/agent-sdk/streaming-output).
* **`ResultMessage`:** marks the end of the agent loop. Contains the final text result, token usage, cost, and session ID. Check the `subtype` field to determine whether the task succeeded or hit a limit. A small number of trailing system events, such as `prompt_suggestion`, can arrive after it, so iterate the stream to completion rather than breaking on the result. See [Handle the result](#handle-the-result).

These five types cover the full agent loop lifecycle. Both SDKs also yield observability events such as rate-limit status and task notifications that are not required to drive the loop. See the [Python message types reference](/docs/en/agent-sdk/python#message-types) and [TypeScript message types reference](/docs/en/agent-sdk/typescript#message-types) for the complete lists.

### Handle messages

Which messages you handle depends on what you're building:

* **Final results only:** handle `ResultMessage` to get the output, cost, and whether the task succeeded or hit a limit.
* **Progress updates:** handle `AssistantMessage` to see what Claude is doing each turn, including which tools it called.
* **Live streaming:** enable partial messages (`include_partial_messages` in Python, `includePartialMessages` in TypeScript) to get `StreamEvent` messages in real time. See [Stream responses in real-time](/docs/en/agent-sdk/streaming-output).

How you check message types depends on the SDK:

* **Python:** check message types with `isinstance()` against classes imported from `claude_agent_sdk` (for example, `isinstance(message, ResultMessage)`).
* **TypeScript:** check the `type` string field (for example, `message.type === "result"`). `AssistantMessage` and `UserMessage` wrap the raw API message in a `.message` field, so content blocks are at `message.message.content`, not `message.content`.

<Accordion title="Example: Check message types and handle results">
  <CodeGroup>
    ```python Python theme={null}
    import asyncio
    from claude_agent_sdk import query, AssistantMessage, ResultMessage


    async def main():
        try:
            async for message in query(prompt="Summarize this project"):
                if isinstance(message, AssistantMessage):
                    print(f"Turn completed: {len(message.content)} content blocks")
                if isinstance(message, ResultMessage):
                    if message.subtype == "success":
                        print(message.result)
                    else:
                        print(f"Stopped: {message.subtype}")
        except Exception as error:
            # A single-shot query() raises after yielding an error result. If the
            # failure was an error result, the error subtype branches above have
            # already run; connection or process failures yield no result message.
            print(f"Session ended with an error: {error}")


    asyncio.run(main())
    ```

    ```typescript TypeScript theme={null}
    import { query } from "@anthropic-ai/claude-agent-sdk";

    try {
      for await (const message of query({ prompt: "Summarize this project" })) {
        if (message.type === "assistant") {
          console.log(`Turn completed: ${message.message.content.length} content blocks`);
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            console.log(message.result);
          } else {
            console.log(`Stopped: ${message.subtype}`);
          }
        }
      }
    } catch (error) {
      // A single-shot query() throws after yielding an error result. If the
      // failure was an error result, the error subtype branches above have
      // already run; connection or process failures yield no result message.
      console.log(`Session ended with an error: ${error}`);
    }
    ```
  </CodeGroup>
</Accordion>

## Tool execution

Tools give your agent the ability to take action. Without tools, Claude can only respond with text. With tools, Claude can read files, run commands, search code, and interact with external services.

### Built-in tools

The SDK includes the same tools that power Claude Code:

| Category            | Tools                                                           | What they do                                                                |
| :------------------ | :-------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| **File operations** | `Read`, `Edit`, `Write`                                         | Read, modify, and create files                                              |
| **Search**          | `Glob`, `Grep`                                                  | Find files by pattern, search content with regex                            |
| **Execution**       | `Bash`                                                          | Run shell commands, scripts, git operations                                 |
| **Web**             | `WebSearch`, `WebFetch`                                         | Search the web, fetch and parse pages                                       |
| **Discovery**       | `ToolSearch`                                                    | Dynamically find and load tools on-demand instead of preloading all of them |
| **Orchestration**   | `Agent`, `Skill`, `AskUserQuestion`, `TaskCreate`, `TaskUpdate` | Spawn subagents, invoke skills, ask the user, track tasks                   |

On the [models that don't get the task-tracking tools](/docs/en/agent-sdk/todo-tracking#model-availability), Claude Code provides `TaskCreate` and `TaskUpdate` only when you opt in.

Beyond built-in tools, you can:

* **Connect external services** with [MCP servers](/docs/en/agent-sdk/mcp) (databases, browsers, APIs)
* **Define custom tools** with [custom tool handlers](/docs/en/agent-sdk/custom-tools)
* **Load project skills** via [setting sources](/docs/en/agent-sdk/claude-code-features) for reusable workflows

### Tool permissions

Claude determines which tools to call based on the task, but you control whether those calls are allowed to execute. You can auto-approve specific tools, block others entirely, or require approval for everything. Three options work together to determine what runs:

* **`allowed_tools` / `allowedTools`** auto-approves listed tools. A read-only agent with `["Read", "Glob", "Grep"]` in its allowed tools list runs those tools without prompting. Tools not listed are still available but require permission.
* **`disallowed_tools` / `disallowedTools`** blocks listed tools, regardless of other settings. See [Permissions](/docs/en/agent-sdk/permissions) for the order that rules are checked before a tool runs.
* **`permission_mode` / `permissionMode`** controls how much human oversight you want. The SDK evaluates the active mode together with your allow and deny rules in a fixed order, described in [How permissions are evaluated](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated). See [Permission mode](#permission-mode) for available modes.

You can also scope individual tools with rules like `"Bash(npm *)"` to allow only specific commands. See [Permissions](/docs/en/agent-sdk/permissions) for the full rule syntax.

When a tool is denied, Claude receives a rejection message as the tool result and typically attempts a different approach or reports that it couldn't proceed.

### Parallel tool execution

When Claude requests multiple tool calls in a single turn, both SDKs can run them concurrently or sequentially depending on the tool. Read-only tools (like `Read`, `Glob`, `Grep`, and MCP tools marked as read-only) can run concurrently. Tools that modify state (like `Edit`, `Write`, and `Bash`) run sequentially to avoid conflicts.

Custom tools default to sequential execution. To enable parallel execution for a custom tool, set `readOnlyHint` in its annotations. Both the [TypeScript](/docs/en/agent-sdk/typescript#tool) and [Python](/docs/en/agent-sdk/python#tool) SDKs use this field name from the MCP SDK.

## Control how the loop runs

You can limit how many turns the loop takes, how much it costs, how deeply Claude reasons, and whether tools require approval before running. All of these are fields on [`ClaudeAgentOptions`](/docs/en/agent-sdk/python#claudeagentoptions) (Python) / [`Options`](/docs/en/agent-sdk/typescript#options) (TypeScript).

### Turns and budget

| Option                                         | What it controls             | Default  |
| :--------------------------------------------- | :--------------------------- | :------- |
| Max turns (`max_turns` / `maxTurns`)           | Maximum tool-use round trips | No limit |
| Max budget (`max_budget_usd` / `maxBudgetUsd`) | Maximum cost before stopping | No limit |

When either limit is hit, the SDK returns a `ResultMessage` with a corresponding error subtype (`error_max_turns` or `error_max_budget_usd`). See [Handle the result](#handle-the-result) for how to check these subtypes and [`ClaudeAgentOptions`](/docs/en/agent-sdk/python#claudeagentoptions) / [`Options`](/docs/en/agent-sdk/typescript#options) for syntax.

The budget cap covers [subagents](/docs/en/agent-sdk/subagents): their spend counts toward the total. Once spend reaches the cap, spawning another subagent fails with `Budget limit reached`, and Claude Code stops any background subagents still running. The cap-enforcement behaviors require Claude Code v2.1.217 or later.

With [streaming input](/docs/en/agent-sdk/streaming-vs-single-mode), a message that is still queued when a turn ends at the max-turns limit stays queued. Claude Code doesn't add it to that turn's last model call. It starts a new turn for the message, and the max-turns count starts over for that turn.

### Effort level

The `effort` option controls how much reasoning Claude applies. Lower effort levels use fewer tokens per turn and reduce cost. Not all models support the effort parameter. See [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) for which models support it.

| Level      | Behavior                          | Good for                                                                  |
| :--------- | :-------------------------------- | :------------------------------------------------------------------------ |
| `"low"`    | Minimal reasoning, fast responses | File lookups, listing directories                                         |
| `"medium"` | Balanced reasoning                | Routine edits, standard tasks                                             |
| `"high"`   | Thorough analysis                 | Refactors, debugging                                                      |
| `"xhigh"`  | Extended reasoning depth          | Coding and agentic tasks; recommended on Fable 5, Opus 4.7+, and Sonnet 5 |
| `"max"`    | Maximum reasoning depth           | Multi-step problems requiring deep analysis                               |

If you don't set `effort`, both SDKs leave the parameter unset and defer to the model's default behavior.

<Note>
  `effort` trades latency and token cost for reasoning depth within each response. [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) is a separate feature that produces `thinking` blocks in the output, and the `display` field on `ThinkingConfig` for [Python](/docs/en/agent-sdk/python#thinkingconfig) or [TypeScript](/docs/en/agent-sdk/typescript#thinkingconfig) controls whether you receive their text. They are independent: you can set `effort: "low"` with extended thinking enabled, or `effort: "max"` without it.
</Note>

Use lower effort for agents doing simple, well-scoped tasks (like listing files or running a single grep) to reduce cost and latency. Set `effort` in the top-level `query()` options for the whole session, or per subagent with the `effort` field on [`AgentDefinition`](/docs/en/agent-sdk/subagents#agentdefinition-configuration) to override the session level.

### Permission mode

The permission mode option (`permission_mode` in Python, `permissionMode` in TypeScript) controls whether the agent asks for approval before using tools:

| Mode                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Use case                                                                                                                                      |
| :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| `"default"`           | Tools not covered by allow rules trigger your `canUseTool` callback; no callback means deny                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Interactive applications with a custom approval callback                                                                                      |
| `"acceptEdits"`       | Auto-approves file edits and common filesystem commands (`mkdir`, `touch`, `mv`, `cp`, etc.); other Bash commands follow default rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | You trust Claude's edits and want faster iteration, such as during prototyping or when working in an isolated directory                       |
| `"plan"`              | Claude explores and plans without editing your source files; file edits are never auto-approved and prompt through your `canUseTool` callback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | You want Claude to propose changes without executing them, such as during code review or when you need to approve changes before they're made |
| `"dontAsk"`           | Never prompts. Tools pre-approved by [permission rules](/docs/en/settings-reference#permission-settings) run; everything else is denied. `AskUserQuestion`, connector tools [your organization set to `ask`](/docs/en/mcp#organization-controls-on-connector-tools), and MCP tools marked [`requiresUserInteraction`](/docs/en/mcp#require-approval-for-a-specific-tool) are denied even if you've allowed them                                                                                                                                                                                                                                                                                                                                                                        | You want a fixed, explicit tool surface for a headless agent and prefer a hard deny over silent reliance on `canUseTool` being absent         |
| `"auto"`              | Uses a model classifier to approve or deny permission prompts. See [Auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) for availability and behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Autonomous agents that still want safety guardrails on tool use                                                                               |
| `"bypassPermissions"` | Runs all allowed tools without asking, except tools matched by an explicit [`ask` rule](/docs/en/settings-reference#permission-settings), connector tools [your organization set to `ask`](/docs/en/mcp#organization-controls-on-connector-tools), and tools that require user interaction. The [cross-session messaging safeguards](/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode) still apply. See [How permissions are evaluated](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated) for the precedence order. In the TypeScript SDK, also requires `allowDangerouslySkipPermissions: true` in `options`. Can't be used when running as root on Unix. Use only in isolated environments where the agent's actions can't affect systems you care about | CI, containers, or other isolated environments                                                                                                |

For interactive applications, use `"default"` with a tool approval callback to surface approval prompts. For autonomous agents on a dev machine, `"acceptEdits"` auto-approves file edits and common filesystem commands (`mkdir`, `touch`, `mv`, `cp`, etc.) while still gating other `Bash` commands behind allow rules. Reserve `"bypassPermissions"` for CI, containers, or other isolated environments. See [Permissions](/docs/en/agent-sdk/permissions) for full details.

### Model

If you don't set `model`, the SDK uses Claude Code's default, which depends on your authentication method and subscription. Set it explicitly (for example, `model="claude-sonnet-5"`) to pin a specific model or to use a smaller model for faster, cheaper agents. See [models](https://platform.claude.com/docs/en/about-claude/models) for available IDs.

## The context window

The context window is the total amount of information available to Claude during a session. It does not reset between turns within a session. Everything accumulates: the system prompt, tool definitions, conversation history, tool inputs, and tool outputs. Content that stays the same across turns (system prompt, tool definitions, CLAUDE.md) is automatically [prompt cached](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), which reduces cost and latency for repeated prefixes. For how a custom system prompt or `append` text affects cache reuse across sessions, see [Modifying system prompts](/docs/en/agent-sdk/modifying-system-prompts#improve-prompt-caching-across-users-and-machines).

### What consumes context

Here's how each component affects context in the SDK:

| Source                   | When it loads                                                             | Impact                                                                                                                                                                                                                                                                                                       |
| :----------------------- | :------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System prompt**        | Every request                                                             | Small fixed cost, always present                                                                                                                                                                                                                                                                             |
| **CLAUDE.md files**      | Session start, via [`settingSources`](/docs/en/agent-sdk/claude-code-features) | Full content in every request (but prompt-cached, so only the first request pays full cost)                                                                                                                                                                                                                  |
| **Tool definitions**     | Every request; MCP schemas deferred by default                            | Built-in tool schemas load every request. [Tool search](/docs/en/agent-sdk/mcp#mcp-tool-search) defers MCP tool schemas by default, falling back to upfront loading on unsupported models and certain platforms. See [Configure tool search](/docs/en/agent-sdk/tool-search#configure-tool-search) for the full matrix |
| **Conversation history** | Accumulates over turns                                                    | Grows with each turn: prompts, responses, tool inputs, tool outputs                                                                                                                                                                                                                                          |
| **Skill descriptions**   | Session start, via setting sources                                        | Short summaries; full content loads only when invoked                                                                                                                                                                                                                                                        |

Large tool outputs consume significant context. Reading a big file or running a command with verbose output can use thousands of tokens in a single turn. Context accumulates across turns, so longer sessions with many tool calls build up significantly more context than short ones.

### Automatic compaction

When the context window approaches its limit, the SDK automatically compacts the conversation: it summarizes older history to free space, keeping your most recent exchanges and key decisions intact. The SDK emits a message with `type: "system"` and `subtype: "compact_boundary"` in the stream when this happens (in Python this is a `SystemMessage`; in TypeScript it is a separate `SDKCompactBoundaryMessage` type).

Compaction replaces older messages with a summary, so specific instructions from early in the conversation may not be preserved. Persistent rules belong in CLAUDE.md (loaded via [`settingSources`](/docs/en/agent-sdk/claude-code-features)) rather than in the initial prompt, because CLAUDE.md content is re-injected on every request.

You can customize compaction behavior in several ways:

* **Summarization instructions in CLAUDE.md:** The compactor reads your CLAUDE.md like any other context, so you can include a section telling it what to preserve when summarizing. The compactor matches on intent, so the section header is free-form.
* **`PreCompact` hook:** Run custom logic before compaction occurs, for example to archive the full transcript. The hook receives a `trigger` field (`manual` or `auto`). See [hooks](/docs/en/agent-sdk/hooks).
* **Manual compaction:** Send `/compact` as a prompt string to trigger compaction on demand. Commands sent this way are ordinary SDK inputs. See [dispatch commands by name](/docs/en/agent-sdk/skills#dispatch-commands-by-name).

<Accordion title="Example: Summarization instructions in CLAUDE.md">
  Add a section to your project's CLAUDE.md telling the compactor what to preserve. The header name isn't special; use any clear label.

  ```markdown CLAUDE.md theme={null}
  # Summary instructions

  When summarizing this conversation, always preserve:
  - The current task objective and acceptance criteria
  - File paths that have been read or modified
  - Test results and error messages
  - Decisions made and the reasoning behind them
  ```
</Accordion>

### Keep context efficient

A few strategies for long-running agents:

* **Use subagents for subtasks.** Each subagent starts with a fresh conversation (no prior message history, though it does load its own system prompt and project-level context like CLAUDE.md). It does not see the parent's turns, and only its final response returns to the parent as a tool result. The main agent's context grows by that summary, not by the full subtask transcript. See [What subagents inherit](/docs/en/agent-sdk/subagents#what-subagents-inherit) for details.
* **Be selective with tools.** Every tool definition takes context space. Use the `tools` field on [`AgentDefinition`](/docs/en/agent-sdk/subagents#agentdefinition-configuration) to scope subagents to the minimum set they need.
* **Watch MCP server costs.** [MCP tool search](/docs/en/agent-sdk/mcp#mcp-tool-search) defers MCP tool schemas by default and loads them on demand. When tool search is off or has fallen back to upfront loading, each MCP server adds all its tool schemas to every request, so a few servers with many tools can consume significant context before the agent does any work. See [Configure tool search](/docs/en/agent-sdk/tool-search#configure-tool-search) for the configurations where the fallback applies.
* **Use lower effort for routine tasks.** Set [effort](#effort-level) to `"low"` for agents that only need to read files or list directories. This reduces token usage and cost.

For a detailed breakdown of per-feature context costs, see [Understand context costs](/docs/en/features-overview#understand-context-costs).

## Sessions and continuity

Each interaction with the SDK creates or continues a session. Capture the session ID from `ResultMessage.session_id` (available in both SDKs) to resume later. The TypeScript SDK also exposes it as a direct field on the init `SystemMessage`; in Python it's nested in `SystemMessage.data`.

When you resume, the full context from previous turns is restored: files that were read, analysis that was performed, and actions that were taken. You can also fork a session to branch into a different approach without modifying the original.

See [Session management](/docs/en/agent-sdk/sessions) for the full guide on resume, continue, and fork patterns. To resume sessions across stateless containers or serverless hosts, pass a [`session_store` / `sessionStore` adapter](/docs/en/agent-sdk/session-storage) so the SDK mirrors transcripts to your own backend and another host can resume them. The Claude Code subprocess still writes to local disk first. See [Dual-write architecture](/docs/en/agent-sdk/session-storage#dual-write-architecture) for which copy outlives a fresh session versus a run resumed from the store, and how to keep the local copy ephemeral.

<Note>
  In Python, `ClaudeSDKClient` handles session IDs automatically across multiple calls. See the [Python SDK reference](/docs/en/agent-sdk/python#choosing-between-query-and-claudesdkclient) for details.
</Note>

## Handle the result

When the loop ends, the `ResultMessage` tells you what happened and gives you the output. The `subtype` field (available in both SDKs) is the primary way to check termination state.

| Result subtype                        | What happened                                                                                                                                                                           | `result` field available? |
| :------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-----------------------: |
| `success`                             | Claude finished the task normally                                                                                                                                                       |            Yes            |
| `error_max_turns`                     | Hit the `maxTurns` limit before finishing                                                                                                                                               |             No            |
| `error_max_budget_usd`                | Hit the `maxBudgetUsd` limit before finishing                                                                                                                                           |             No            |
| `error_during_execution`              | An error interrupted the loop (for example, an API failure or cancelled request)                                                                                                        |             No            |
| `error_max_structured_output_retries` | No valid structured output was produced within the configured retry limit: every attempt failed validation, or a model fallback retracted the completed output with no successful retry |             No            |

The `result` field holds the final text output and is only present on the `success` variant, so always check the subtype before reading it.

All result subtypes carry `total_cost_usd`, `usage`, `num_turns`, and `session_id` so you can track cost and resume even after errors. Two things to guard for:

* After a session crash, the final result is an `error_during_execution` whose cost fields may be zeroed and whose `stop_reason` is `null`, and the process exits after emitting it. See [Recover totals after a session crash](/docs/en/agent-sdk/cost-tracking#recover-totals-after-a-session-crash).
* In Python, `total_cost_usd`, `usage`, and `model_usage` are typed as optional, so check that they aren't `None` before you read them.

The `usage` field covers only the main agent loop. Use `modelUsage`, or `model_usage` in Python, for whole-tree token and cost accounting. See [Tracking costs and usage](/docs/en/agent-sdk/cost-tracking) for details on interpreting the `usage` fields.

<Note>
  When a query ends on an error result:

  * A single-shot `query()` call yields the final result message, then raises an error that includes the failure text, such as `Reached maximum number of turns`. The raise is intentional. Wrap the loop in a try block if your code needs to continue past it. The underlying Claude Code process also exits with a nonzero code.
  * A streaming input session stays alive, and you can keep sending messages, except after a session crash, which emits a final `error_during_execution` result and exits the process.
</Note>

The result also includes a `stop_reason` field (`string | null` in TypeScript, `str | None` in Python) indicating why the model stopped generating on its final turn. Common values are `end_turn` (model finished normally), `max_tokens` (hit the output token limit), and `refusal` (the model declined the request). On error results that the loop produced, `stop_reason` carries the value from the last assistant response before the loop ended; the result Claude Code synthesizes after a session crash carries `null`.

To detect refusals, check `stop_reason === "refusal"` (TypeScript) or `stop_reason == "refusal"` (Python). See [`SDKResultMessage`](/docs/en/agent-sdk/typescript#sdkresultmessage) (TypeScript) or [`ResultMessage`](/docs/en/agent-sdk/python#resultmessage) (Python) for the full type.

## Hooks

[Hooks](/docs/en/agent-sdk/hooks) are callbacks that fire at specific points in the loop: before a tool runs, after it returns, when the agent finishes, and so on. Some commonly used hooks are:

| Hook                             | When it fires                       | Common uses                                |
| :------------------------------- | :---------------------------------- | :----------------------------------------- |
| `PreToolUse`                     | Before a tool executes              | Validate inputs, block dangerous commands  |
| `PostToolUse`                    | After a tool returns                | Audit outputs, trigger side effects        |
| `UserPromptSubmit`               | When a prompt is sent               | Inject additional context into prompts     |
| `Stop`                           | When the agent finishes             | Validate the result, save session state    |
| `SubagentStart` / `SubagentStop` | When a subagent spawns or completes | Track and aggregate parallel task results  |
| `PreCompact`                     | Before context compaction           | Archive full transcript before summarizing |

Hooks run in your application process, not inside the agent's context window, so they don't consume context. Hooks can also short-circuit the loop: a `PreToolUse` hook that rejects a tool call prevents it from executing, and Claude receives the rejection message instead.

Both SDKs support all the events above. The TypeScript SDK includes additional events that Python does not yet support. See [Control execution with hooks](/docs/en/agent-sdk/hooks) for the complete event list, per-SDK availability, and the full callback API.

## Put it all together

This example combines the key concepts from this page into a single agent that fixes failing tests. It configures the agent with allowed tools (auto-approved so the agent runs autonomously), project settings, and safety limits on turns and reasoning effort. As the loop runs, it captures the session ID for potential resumption, handles the final result, and prints the total cost.

Because a single-shot `query()` call raises after yielding an error result, the loop is wrapped in a try block so the script exits cleanly when a limit is hit.

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def run_agent():
      session_id = None

      try:
          async for message in query(
              prompt="Find and fix the bug causing test failures in the auth module",
              options=ClaudeAgentOptions(
                  allowed_tools=[
                      "Read",
                      "Edit",
                      "Bash",
                      "Glob",
                      "Grep",
                  ],  # Listing tools here auto-approves them (no prompting)
                  setting_sources=[
                      "project"
                  ],  # Load CLAUDE.md, skills, hooks from current directory
                  max_turns=30,  # Prevent runaway sessions
                  effort="high",  # Thorough reasoning for complex debugging
              ),
          ):
              # Handle the final result
              if isinstance(message, ResultMessage):
                  session_id = message.session_id  # Save for potential resumption

                  if message.subtype == "success":
                      print(f"Done: {message.result}")
                  elif message.subtype == "error_max_turns":
                      # Agent ran out of turns. Resume with a higher limit.
                      print(f"Hit turn limit. Resume session {session_id} to continue.")
                  elif message.subtype == "error_max_budget_usd":
                      print("Hit budget limit.")
                  else:
                      print(f"Stopped: {message.subtype}")
                  if message.total_cost_usd is not None:
                      print(f"Cost: ${message.total_cost_usd:.4f}")
      except Exception as error:
          # A single-shot query() raises after yielding an error result. If the
          # failure was an error result, the error subtype branches above have
          # already run; connection or process failures yield no result message.
          print(f"Session ended with an error: {error}")


  asyncio.run(run_agent())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  let sessionId: string | undefined;

  try {
    for await (const message of query({
      prompt: "Find and fix the bug causing test failures in the auth module",
      options: {
        allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"], // Listing tools here auto-approves them (no prompting)
        settingSources: ["project"], // Load CLAUDE.md, skills, hooks from current directory
        maxTurns: 30, // Prevent runaway sessions
        effort: "high" // Thorough reasoning for complex debugging
      }
    })) {
      // Save the session ID to resume later if needed
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }

      // Handle the final result
      if (message.type === "result") {
        if (message.subtype === "success") {
          console.log(`Done: ${message.result}`);
        } else if (message.subtype === "error_max_turns") {
          // Agent ran out of turns. Resume with a higher limit.
          console.log(`Hit turn limit. Resume session ${sessionId} to continue.`);
        } else if (message.subtype === "error_max_budget_usd") {
          console.log("Hit budget limit.");
        } else {
          console.log(`Stopped: ${message.subtype}`);
        }
        console.log(`Cost: $${message.total_cost_usd.toFixed(4)}`);
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result. If the
    // failure was an error result, the error subtype branches above have
    // already run; connection or process failures yield no result message.
    console.log(`Session ended with an error: ${error}`);
  }
  ```
</CodeGroup>

When the agent finishes successfully, the example prints a `Done:` line with the agent's summary of the fix, then a line like `Cost: $0.0312`.

## Next steps

Now that you understand the loop, here's where to go depending on what you're building:

* **Haven't run an agent yet?** Start with the [quickstart](/docs/en/agent-sdk/quickstart) to get the SDK installed and see a full example running end to end.
* **Ready to hook into your project?** [Load CLAUDE.md, skills, and filesystem hooks](/docs/en/agent-sdk/claude-code-features) so the agent follows your project conventions automatically.
* **Building an interactive UI?** Enable [streaming](/docs/en/agent-sdk/streaming-output) to show live text and tool calls as the loop runs.
* **Need tighter control over what the agent can do?** Lock down tool access with [permissions](/docs/en/agent-sdk/permissions), and use [hooks](/docs/en/agent-sdk/hooks) to audit, block, or transform tool calls before they execute.
* **Running long or expensive tasks?** Offload isolated work to [subagents](/docs/en/agent-sdk/subagents) to keep your main context lean.
* **Deploying as a service?** See [Hosting the Agent SDK](/docs/en/agent-sdk/hosting) for container and serverless guidance, and [Session storage](/docs/en/agent-sdk/session-storage) to persist sessions to your own backend.

For the broader conceptual picture of the agentic loop (not SDK-specific), see [How Claude Code works](/docs/en/how-claude-code-works). For a practical guide to designing loops in Claude Code, from turn-based to goal-based and proactive loops, see [Loop engineering: getting started with loops](https://claude.com/blog/getting-started-with-loops) on the blog.
