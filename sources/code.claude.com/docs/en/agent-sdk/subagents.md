> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Subagents in the SDK

> Define and invoke subagents to isolate context, run tasks in parallel, and apply specialized instructions in your Claude Agent SDK applications.

Subagents are separate agent instances that your main agent can spawn to handle focused subtasks.
Use them to isolate context, run multiple analyses in parallel, and apply specialized instructions without adding to the main agent's prompt.

This guide explains how to define and use subagents in the SDK using the `agents` parameter.

## Overview

You can create subagents in three ways:

* **Programmatically**: use the `agents` parameter in your `query()` options. See the [TypeScript](/docs/en/agent-sdk/typescript#agentdefinition) and [Python](/docs/en/agent-sdk/python#agentdefinition) references
* **Filesystem-based**: define agents as markdown files in `.claude/agents/` directories. See [defining subagents as files](/docs/en/sub-agents)
* **Built-in general-purpose**: Claude can invoke the built-in `general-purpose` subagent at any time via the Agent tool without you defining anything

This guide focuses on the programmatic approach, which is recommended for SDK applications.

## Benefits of using subagents

Because subagents are separate agent instances, delegating work to them gives you four benefits:

* **Context isolation**: each subagent runs in its own conversation, which starts fresh unless the subagent is a [fork](/docs/en/sub-agents#fork-the-current-conversation). Either way, intermediate tool calls and results stay inside the subagent; only its final message returns to the parent. A `research-assistant` subagent can explore dozens of files without any of that content accumulating in the main conversation. The parent receives a concise summary, not every file the subagent read. See [What subagents inherit](#what-subagents-inherit) for exactly what's in the subagent's context.
* **Parallelization**: multiple subagents can run concurrently, so independent subtasks finish in the time of the slowest one rather than the sum of all of them. During a code review, you can run `style-checker`, `security-scanner`, and `test-coverage` subagents simultaneously instead of sequentially.
* **Specialized instructions and knowledge**: each subagent can have a tailored system prompt with specific expertise, best practices, and constraints. A `database-migration` subagent can have detailed knowledge about SQL best practices, rollback strategies, and data integrity checks that would be unnecessary noise in the main agent's instructions.
* **Tool restrictions**: subagents can be limited to specific tools, reducing the risk of unintended actions. A `doc-reviewer` subagent might only have access to Read and Grep tools, ensuring it can analyze but never accidentally modify your documentation files.

## Create subagents

### Programmatic definition (recommended)

Define subagents directly in your code using the `agents` parameter. Claude invokes subagents through the `Agent` tool, so include `Agent` in `allowedTools` to auto-approve subagent invocations without a permission prompt.

Most examples on this page print only the final result. To confirm that Claude delegated to a subagent rather than answering directly, see [Detect subagent invocation](#detect-subagent-invocation).

This example creates two subagents: a code reviewer with read-only access and a test runner that can execute commands.

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition


  async def main():
      async for message in query(
          prompt="Review the authentication module for security issues",
          options=ClaudeAgentOptions(
              # Auto-approve these tools, including Agent for subagent invocation
              allowed_tools=["Read", "Grep", "Glob", "Agent"],
              agents={
                  "code-reviewer": AgentDefinition(
                      # description tells Claude when to use this subagent
                      description="Expert code review specialist. Use for quality, security, and maintainability reviews.",
                      # prompt defines the subagent's behavior and expertise
                      prompt="""You are a code review specialist with expertise in security, performance, and best practices.

  When reviewing code:
  - Identify security vulnerabilities
  - Check for performance issues
  - Verify adherence to coding standards
  - Suggest specific improvements

  Be thorough but concise in your feedback.""",
                      # tools restricts what the subagent can do (read-only here)
                      tools=["Read", "Grep", "Glob"],
                      # model overrides the default model for this subagent
                      model="sonnet",
                  ),
                  "test-runner": AgentDefinition(
                      description="Runs and analyzes test suites. Use for test execution and coverage analysis.",
                      prompt="""You are a test execution specialist. Run tests and provide clear analysis of results.

  Focus on:
  - Running test commands
  - Analyzing test output
  - Identifying failing tests
  - Suggesting fixes for failures""",
                      # Bash access lets this subagent run test commands
                      tools=["Bash", "Read", "Grep"],
                  ),
              },
          ),
      ):
          if hasattr(message, "result"):
              print(message.result)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Review the authentication module for security issues",
    options: {
      // Auto-approve these tools, including Agent for subagent invocation
      allowedTools: ["Read", "Grep", "Glob", "Agent"],
      agents: {
        "code-reviewer": {
          // description tells Claude when to use this subagent
          description:
            "Expert code review specialist. Use for quality, security, and maintainability reviews.",
          // prompt defines the subagent's behavior and expertise
          prompt: `You are a code review specialist with expertise in security, performance, and best practices.

  When reviewing code:
  - Identify security vulnerabilities
  - Check for performance issues
  - Verify adherence to coding standards
  - Suggest specific improvements

  Be thorough but concise in your feedback.`,
          // tools restricts what the subagent can do (read-only here)
          tools: ["Read", "Grep", "Glob"],
          // model overrides the default model for this subagent
          model: "sonnet"
        },
        "test-runner": {
          description:
            "Runs and analyzes test suites. Use for test execution and coverage analysis.",
          prompt: `You are a test execution specialist. Run tests and provide clear analysis of results.

  Focus on:
  - Running test commands
  - Analyzing test output
  - Identifying failing tests
  - Suggesting fixes for failures`,
          // Bash access lets this subagent run test commands
          tools: ["Bash", "Read", "Grep"]
        }
      }
    }
  })) {
    if ("result" in message) console.log(message.result);
  }
  ```
</CodeGroup>

### AgentDefinition configuration

| Field             | Type                                                        | Required | Description                                                                                                                                                                                                                                                                                                                                           |
| :---------------- | :---------------------------------------------------------- | :------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`     | `string`                                                    | Yes      | Natural language description of when to use this agent                                                                                                                                                                                                                                                                                                |
| `prompt`          | `string`                                                    | Yes      | The agent's system prompt defining its role and behavior                                                                                                                                                                                                                                                                                              |
| `tools`           | `string[]`                                                  | No       | Array of allowed tool names. If omitted, inherits every [tool available to subagents](/docs/en/sub-agents#available-tools)                                                                                                                                                                                                                                 |
| `disallowedTools` | `string[]`                                                  | No       | Array of tool names to remove from the agent's tool set. MCP server-level patterns are also accepted: `mcp__server` or `mcp__server__*` removes every tool from that server, and `mcp__*` removes every MCP tool from any server                                                                                                                      |
| `model`           | `string`                                                    | No       | Model override for this agent. Accepts an alias such as `'fable'`, `'opus'`, `'sonnet'`, `'haiku'`, `'inherit'`, or a full model ID. `'inherit'` uses the main model. If omitted, the agent uses the default subagent model ([`CLAUDE_CODE_SUBAGENT_MODEL`](/docs/en/model-config#environment-variables)) when one is configured, otherwise the main model |
| `skills`          | `string[]`                                                  | No       | List of skill names to preload into the agent's context at startup. Unlisted skills remain invocable through the Skill tool                                                                                                                                                                                                                           |
| `memory`          | `'user' \| 'project' \| 'local'`                            | No       | Memory source for this agent                                                                                                                                                                                                                                                                                                                          |
| `mcpServers`      | `(string \| object)[]`                                      | No       | MCP servers available to this agent, by name or inline config                                                                                                                                                                                                                                                                                         |
| `initialPrompt`   | `string`                                                    | No       | Auto-submitted as the first user turn when this agent runs as the main thread agent. Ignored when the agent is invoked as a subagent                                                                                                                                                                                                                  |
| `maxTurns`        | `number`                                                    | No       | Maximum number of agentic turns before the agent stops. When the agent reaches the limit, Claude Code returns its output marked as partial, and you can [resume the agent](#resume-subagents) to continue. The partial marking requires Claude Code v2.1.246 or later                                                                                 |
| `background`      | `boolean`                                                   | No       | Run this agent as a non-blocking background task when invoked                                                                                                                                                                                                                                                                                         |
| `effort`          | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max' \| number` | No       | Reasoning effort level for this agent                                                                                                                                                                                                                                                                                                                 |
| `permissionMode`  | `PermissionMode`                                            | No       | Permission mode for tool execution within this agent                                                                                                                                                                                                                                                                                                  |

In the Python SDK, multi-word field names such as `disallowedTools` and `mcpServers` keep their camelCase spelling to match the wire format rather than following Python's snake\_case convention. See the [`AgentDefinition` reference](/docs/en/agent-sdk/python#agentdefinition) for details.

Two subagent behaviors changed in Claude Code v2.1.198:

* Subagents run in the background by default. An Agent tool call that omits the [`run_in_background`](/docs/en/agent-sdk/typescript) input launches a background subagent, and Claude sets `run_in_background: false` when it needs the result before continuing. Before v2.1.198, omitting `run_in_background` ran the subagent synchronously. Set the `background` field to `true` to force background execution for a specific agent regardless of what Claude requests.
* A subagent inherits the main session's extended thinking configuration.

Subagents can also spawn subagents of their own. To limit how deep that nesting goes, how many subagents run at once, and how much a query spends, see [Cap subagent depth, concurrency, and spend](#cap-subagent-depth-concurrency-and-spend).

### Filesystem-based definition (alternative)

You can also define subagents as markdown files in `.claude/agents/` directories. See the [Claude Code subagents documentation](/docs/en/sub-agents) for details on this approach. Programmatically defined agents take precedence over filesystem-based agents with the same name.

<Note>
  Even without defining custom subagents, Claude can spawn the built-in `general-purpose` subagent. This is useful for delegating research or exploration tasks without creating specialized agents. Include `Agent` in `allowedTools` so these invocations auto-approve without a permission prompt.

  When Claude calls the Agent tool without a `subagent_type`, it gets this built-in `general-purpose` subagent. If you set [`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`](/docs/en/env-vars), that default is gone too. Such a call then fails with `subagent_type is required: the general-purpose agent is not available in this session`. The message ends with the subagent types that are still available. Before TypeScript SDK v0.3.235 (Python SDK: bundled Claude Code before v2.1.235), the same call failed with `Agent type 'general-purpose' not found`.
</Note>

## What subagents inherit

Unless the subagent is a [fork](/docs/en/sub-agents#fork-the-current-conversation), its context window starts fresh, with no parent conversation, but isn't empty. The only content you pass from parent to subagent is the Agent tool's prompt string, so include any file paths, error messages, or decisions the subagent needs directly in that prompt.

A subagent that has the [`SendMessage`](/docs/en/tools-reference) tool starts with a list of the other named agents running in the session, so it knows which names it can send messages to. Claude Code adds the list to the subagent's first turn automatically. A [fork](/docs/en/sub-agents#fork-the-current-conversation) doesn't get the list because it inherits the parent conversation instead. The list requires Claude Code v2.1.206 or later.

The table below lists what a non-fork subagent's context contains and what it leaves out.

| The subagent receives                                                                                                                 | The subagent doesn't receive                                       |
| :------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------- |
| Its own system prompt (`AgentDefinition.prompt`) and the Agent tool's prompt                                                          | The parent's conversation history or tool results                  |
| Project CLAUDE.md (loaded via [`settingSources`](/docs/en/agent-sdk/claude-code-features#control-filesystem-settings-with-settingsources)) | Preloaded skill content, unless listed in `AgentDefinition.skills` |
| Tool definitions (inherited from parent or the subset in `tools`, [filtered for background runs](/docs/en/sub-agents#available-tools))     | The parent's system prompt                                         |

<Note>
  The parent receives the subagent's final message as the Agent tool result, but may summarize it in its own response. To preserve subagent output verbatim in the user-facing response, include an instruction to do so in the prompt or `systemPrompt` option you pass to the main `query()` call.

  In v2.1.210 and later, Claude Code [scans the final message for instruction-shaped patterns](/docs/en/sub-agents#subagent-output-scanning) before the parent reads it. The scan treats three kinds of pattern differently:

  * **Control-tag imitation**: Claude Code neutralizes a tag that only the harness emits, such as a `<system-reminder>` block, in place. It inserts a backslash after the opening angle bracket and deletes nothing.
  * **Permission-configuration mentions**: Claude Code keeps references to the permission configuration, such as `.claude/settings.json`, `bypassPermissions`, or `--dangerously-skip-permissions`, as written.
  * **Turn markers**: a line that starts with `Human:` or `Assistant:` gets a backslash before the colon, so the message can't imitate a conversation turn boundary.

  For a control-tag or permission-configuration match, Claude Code prepends a `[harness: ...]` marker line naming the matched patterns; a turn-marker match doesn't add the marker line. Those are the only modifications the scan makes: it never removes or rewords the subagent's text.
</Note>

An API error that ends the subagent early, such as a rate limit, is never delivered as its result. See [API errors in subagents](/docs/en/sub-agents#api-errors-in-subagents) for the foreground and background behavior.

## Invoke subagents

### Automatic invocation

Claude automatically decides when to invoke subagents based on the task and each subagent's `description`. For example, if you define a `performance-optimizer` subagent with the description "Performance optimization specialist for query tuning", Claude will invoke it when your prompt mentions optimizing queries.

Write clear, specific descriptions so Claude can match tasks to the right subagent.

### Explicit invocation

To guarantee Claude uses a specific subagent, mention it by name in your prompt:

```text theme={null}
"Use the code-reviewer agent to check the authentication module"
```

This bypasses automatic matching and directly invokes the named subagent.

### Dynamic agent configuration

You can create agent definitions dynamically based on runtime conditions. This example creates a security reviewer with different strictness levels, using a more capable model for strict reviews.

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition


  # Factory function that returns an AgentDefinition
  # This pattern lets you customize agents based on runtime conditions
  def create_security_agent(security_level: str) -> AgentDefinition:
      is_strict = security_level == "strict"
      return AgentDefinition(
          description="Security code reviewer",
          # Customize the prompt based on strictness level
          prompt=f"You are a {'strict' if is_strict else 'balanced'} security reviewer...",
          tools=["Read", "Grep", "Glob"],
          # Key insight: use a more capable model for high-stakes reviews
          model="opus" if is_strict else "sonnet",
      )


  async def main():
      # The agent is created at query time, so each request can use different settings
      async for message in query(
          prompt="Review this PR for security issues",
          options=ClaudeAgentOptions(
              allowed_tools=["Read", "Grep", "Glob", "Agent"],
              agents={
                  # Call the factory with your desired configuration
                  "security-reviewer": create_security_agent("strict")
              },
          ),
      ):
          if hasattr(message, "result"):
              print(message.result)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

  // Factory function that returns an AgentDefinition
  // This pattern lets you customize agents based on runtime conditions
  function createSecurityAgent(securityLevel: "basic" | "strict"): AgentDefinition {
    const isStrict = securityLevel === "strict";
    return {
      description: "Security code reviewer",
      // Customize the prompt based on strictness level
      prompt: `You are a ${isStrict ? "strict" : "balanced"} security reviewer...`,
      tools: ["Read", "Grep", "Glob"],
      // Key insight: use a more capable model for high-stakes reviews
      model: isStrict ? "opus" : "sonnet"
    };
  }

  // The agent is created at query time, so each request can use different settings
  for await (const message of query({
    prompt: "Review this PR for security issues",
    options: {
      allowedTools: ["Read", "Grep", "Glob", "Agent"],
      agents: {
        // Call the factory with your desired configuration
        "security-reviewer": createSecurityAgent("strict")
      }
    }
  })) {
    if ("result" in message) console.log(message.result);
  }
  ```
</CodeGroup>

## Detect subagent invocation

Claude invokes subagents through the Agent tool. To detect when a subagent is invoked, check for `tool_use` blocks where `name` is `"Agent"`. Messages from within a subagent's context include a `parent_tool_use_id` field.

<Note>
  The tool name was renamed from `"Task"` to `"Agent"` in Claude Code v2.1.63. Current SDK releases emit `"Agent"` in `tool_use` blocks but still use `"Task"` in the `system:init` tools list and in `result.permission_denials[].tool_name`. Checking both values in `block.name` ensures compatibility across SDK versions.
</Note>

The message structure differs between SDKs. In Python, you access content blocks directly via `message.content`. In TypeScript, `SDKAssistantMessage` wraps the Claude API message, so you access content via `message.message.content`.

This example iterates through streamed messages, logging when a subagent is invoked and when subsequent messages originate from within that subagent's execution context.

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition, ToolUseBlock


  async def main():
      async for message in query(
          prompt="Use the code-reviewer agent to review this codebase",
          options=ClaudeAgentOptions(
              allowed_tools=["Read", "Glob", "Grep", "Agent"],
              agents={
                  "code-reviewer": AgentDefinition(
                      description="Expert code reviewer.",
                      prompt="Analyze code quality and suggest improvements.",
                      tools=["Read", "Glob", "Grep"],
                  )
              },
          ),
      ):
          # Check for subagent invocation. Match both names: older SDK
          # versions emitted "Task", current versions emit "Agent".
          if hasattr(message, "content") and message.content:
              for block in message.content:
                  if isinstance(block, ToolUseBlock) and block.name in (
                      "Task",
                      "Agent",
                  ):
                      print(f"Subagent invoked: {block.input.get('subagent_type')}")

          # Check if this message is from within a subagent's context
          if hasattr(message, "parent_tool_use_id") and message.parent_tool_use_id:
              print("  (running inside subagent)")

          if hasattr(message, "result"):
              print(message.result)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Use the code-reviewer agent to review this codebase",
    options: {
      allowedTools: ["Read", "Glob", "Grep", "Agent"],
      agents: {
        "code-reviewer": {
          description: "Expert code reviewer.",
          prompt: "Analyze code quality and suggest improvements.",
          tools: ["Read", "Glob", "Grep"]
        }
      }
    }
  })) {
    const msg = message as any;

    // Check for subagent invocation. Match both names: older SDK versions
    // emitted "Task", current versions emit "Agent".
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_use" && (block.name === "Task" || block.name === "Agent")) {
        console.log(`Subagent invoked: ${block.input.subagent_type}`);
      }
    }

    // Check if this message is from within a subagent's context
    if (msg.parent_tool_use_id) {
      console.log("  (running inside subagent)");
    }

    if ("result" in message) {
      console.log(message.result);
    }
  }
  ```
</CodeGroup>

## Resume subagents

You can resume a subagent to continue where it left off rather than starting fresh. A resumed subagent retains its full conversation history, including all previous tool calls, results, and reasoning.

When a subagent stops at its [`maxTurns`](#agentdefinition-configuration) limit, Claude Code marks the output in the Agent tool result as partial, so Claude knows the run is unfinished.

When a subagent completes, the Agent tool result includes a text block containing `agentId: <id>`. The built-in [`Explore` and `Plan` agents](/docs/en/sub-agents#built-in-subagents) are one-shot and don't return an `agentId`, so use a custom agent or `general-purpose` when you need to resume. To resume a subagent programmatically:

1. **Capture the session ID**: extract `session_id` from messages during the first query
2. **Extract the agent ID**: parse `agentId` from the Agent tool result text
3. **Resume the session**: pass `resume: sessionId` in the second query's options, and include the agent ID in your prompt

<Note>
  You must resume the same session to access the subagent's transcript. Each `query()` call starts a new session by default, so pass `resume: sessionId` to continue in the same session.

  When using a custom agent, pass the same agent definition in the `agents` parameter for both queries.
</Note>

The example below defines a custom `endpoint-finder` agent. The first query runs it and captures the session ID and agent ID from the Agent tool result, then the second query resumes the session to ask a follow-up question that requires context from the first analysis.

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  import re
  from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition, ToolResultBlock

  AGENTS = {
      "endpoint-finder": AgentDefinition(
          description="Locates and catalogs API endpoints in a codebase.",
          prompt="You find and document API endpoints. Report each endpoint's path, method, and handler.",
          tools=["Read", "Grep", "Glob"],
      )
  }


  def extract_agent_id(block: ToolResultBlock) -> str | None:
      """Extract agentId from an Agent tool result's text content."""
      parts = block.content if isinstance(block.content, list) else [{"text": block.content}]
      for part in parts:
          if match := re.search(r"agentId:\s*([\w-]+)", part.get("text") or ""):
              return match.group(1)
      return None


  async def main():
      agent_id = None
      session_id = None

      # First invocation - run the endpoint-finder subagent
      try:
          async for message in query(
              prompt="Use the endpoint-finder agent to find all API endpoints in this codebase",
              options=ClaudeAgentOptions(allowed_tools=["Read", "Grep", "Glob", "Agent"], agents=AGENTS),
          ):
              # Capture session_id from ResultMessage (needed to resume this session)
              if hasattr(message, "session_id"):
                  session_id = message.session_id
              # Search tool results for the agentId trailer
              for block in getattr(message, "content", None) or []:
                  if isinstance(block, ToolResultBlock):
                      agent_id = extract_agent_id(block) or agent_id
              # Print the final result
              if hasattr(message, "result"):
                  print(message.result)
      except Exception as error:
          # A single-shot query() raises after yielding an error result,
          # so session_id and agent_id have already been captured by the loop above.
          print(f"Session ended with an error: {error}")

      # Second invocation - resume and ask follow-up
      if agent_id and session_id:
          async for message in query(
              prompt=f"Resume agent {agent_id} and list the top 3 most complex endpoints",
              options=ClaudeAgentOptions(
                  allowed_tools=["Read", "Grep", "Glob", "Agent"], agents=AGENTS, resume=session_id
              ),
          ):
              if hasattr(message, "result"):
                  print(message.result)
      else:
          print("No agentId found in the first query, so there is no subagent to resume.")


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

  const agents = {
    "endpoint-finder": {
      description: "Locates and catalogs API endpoints in a codebase.",
      prompt: "You find and document API endpoints. Report each endpoint's path, method, and handler.",
      tools: ["Read", "Grep", "Glob"]
    }
  };

  // Stringify content to search for agentId without traversing nested block types
  function extractAgentId(message: SDKMessage): string | undefined {
    if (message.type !== "assistant" && message.type !== "user") return undefined;
    const content = JSON.stringify(message.message.content);
    const match = content.match(/agentId:\s*([\w-]+)/);
    return match?.[1];
  }

  let agentId: string | undefined;
  let sessionId: string | undefined;

  // First invocation - run the endpoint-finder subagent
  try {
    for await (const message of query({
      prompt: "Use the endpoint-finder agent to find all API endpoints in this codebase",
      options: { allowedTools: ["Read", "Grep", "Glob", "Agent"], agents }
    })) {
      // Capture session_id from ResultMessage (needed to resume this session)
      if ("session_id" in message) sessionId = message.session_id;
      // Search message content for the agentId (appears in Agent tool results)
      const extractedId = extractAgentId(message);
      if (extractedId) agentId = extractedId;
      // Print the final result
      if ("result" in message) console.log(message.result);
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result,
    // so sessionId and agentId have already been captured by the loop above.
    console.error(`Session ended with an error: ${error}`);
  }

  // Second invocation - resume and ask follow-up
  if (agentId && sessionId) {
    for await (const message of query({
      prompt: `Resume agent ${agentId} and list the top 3 most complex endpoints`,
      options: { allowedTools: ["Read", "Grep", "Glob", "Agent"], agents, resume: sessionId }
    })) {
      if ("result" in message) console.log(message.result);
    }
  } else {
    console.log("No agentId found in the first query, so there is no subagent to resume.");
  }
  ```
</CodeGroup>

Subagent transcripts are stored in separate files and persist independently of the main conversation. See [resume subagents in Claude Code](/docs/en/sub-agents#resume-subagents) for compaction behavior and the `cleanupPeriodDays` cleanup period.

## Tool restrictions

Use the `tools` field to limit what a subagent can do:

* **Omit `tools`**: the subagent gets every [tool available to subagents](/docs/en/sub-agents#available-tools)
* **List tools**: the subagent gets only those. A code reviewer that should never edit files, for example, gets `["Read", "Grep", "Glob"]`

A tool you leave out isn't in the subagent's session at all: Claude works without it, with no permission prompt or error.

This example creates a read-only analysis agent that can examine code but can't modify files or run commands.

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition


  async def main():
      async for message in query(
          prompt="Analyze the architecture of this codebase",
          options=ClaudeAgentOptions(
              allowed_tools=["Read", "Grep", "Glob", "Agent"],
              agents={
                  "code-analyzer": AgentDefinition(
                      description="Static code analysis and architecture review",
                      prompt="""You are a code architecture analyst. Analyze code structure,
  identify patterns, and suggest improvements without making changes.""",
                      # Read-only tools: no Edit, Write, or Bash access
                      tools=["Read", "Grep", "Glob"],
                  )
              },
          ),
      ):
          if hasattr(message, "result"):
              print(message.result)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Analyze the architecture of this codebase",
    options: {
      allowedTools: ["Read", "Grep", "Glob", "Agent"],
      agents: {
        "code-analyzer": {
          description: "Static code analysis and architecture review",
          prompt: `You are a code architecture analyst. Analyze code structure,
  identify patterns, and suggest improvements without making changes.`,
          // Read-only tools: no Edit, Write, or Bash access
          tools: ["Read", "Grep", "Glob"]
        }
      }
    }
  })) {
    if ("result" in message) console.log(message.result);
  }
  ```
</CodeGroup>

### Common tool combinations

| Use case           | Tools                                   | Description                                                        |
| :----------------- | :-------------------------------------- | :----------------------------------------------------------------- |
| Read-only analysis | `Read`, `Grep`, `Glob`                  | Can examine code but not modify or execute                         |
| Test execution     | `Bash`, `Read`, `Grep`                  | Can run commands and analyze output                                |
| Code modification  | `Read`, `Edit`, `Write`, `Grep`, `Glob` | Full read/write access without command execution                   |
| Full access        | All tools                               | Inherits the tools available to subagents (omit the `tools` field) |

## Cap subagent depth, concurrency, and spend

<Note>
  This section describes TypeScript SDK v0.3.219 and Python SDK v0.2.127 and later, the releases that bundle Claude Code v2.1.219 or later. On earlier releases, some of these limits are missing or default differently, so upgrade before you rely on them to bound a run. The [environment variable reference](/docs/en/env-vars) and [turns and budget](/docs/en/agent-sdk/agent-loop#turns-and-budget) record the Claude Code version that added each variable and the spend cap's subagent enforcement.
</Note>

Once you include `Agent` in `allowedTools`, Claude decides on its own when to spawn a subagent and how many to spawn. Each subagent makes its own API requests, which count toward the query's `total_cost_usd`, and a subagent can spawn subagents of its own, so one prompt can grow into a tree of agents.

You can cap that growth in three ways: how deeply subagents nest, how many run at once, and how much the whole query spends. Set the depth and concurrency limits as environment variables through the [`env`](/docs/en/agent-sdk/typescript#options) option, and the spend limit as a query option:

| Limit       | Set it with                                              | Default                                                                                                | What Claude Code does at the limit                                                                                                                                                                                                                                                                       |
| :---------- | :------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depth       | [`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`](/docs/en/env-vars)   | `3` layers of subagents below your main agent. `1` stops your subagents from spawning any of their own | Leaves a subagent at the bottom layer unable to spawn, so it does its delegated work itself. See [nested subagents](/docs/en/sub-agents#let-subagents-spawn-their-own-subagents)                                                                                                                              |
| Concurrency | [`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`](/docs/en/env-vars)   | `20` subagents running at once, counting every subagent Claude spawns with the Agent tool              | Refuses to spawn another subagent, returning `Concurrent subagent limit reached`, until the running count drops below the limit. Sessions with [ultracode](/docs/en/model-config#adjust-effort-level) active are never refused. See the [concurrent subagent limit](/docs/en/sub-agents#concurrent-subagent-limit) |
| Spend       | `maxBudgetUsd` in TypeScript, `max_budget_usd` in Python | No limit. Compared against `total_cost_usd`, so subagent requests count                                | Enforces the cap in three ways: refuses to spawn more subagents, returning `Budget limit reached`, stops background subagents that are still running, and ends the query with the `error_max_budget_usd` result subtype. See [turns and budget](/docs/en/agent-sdk/agent-loop#turns-and-budget)               |

The two SDKs treat the `env` option differently: the TypeScript SDK replaces the subprocess environment with it, so spread `process.env` into it to keep variables like `PATH`, while the Python SDK merges it into the inherited environment. This example turns nesting off, allows at most five subagents at a time, and stops the query once the estimated spend reaches \$5:

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      try:
          async for message in query(
              prompt="Audit every service in this repo for unhandled promise rejections",
              options=ClaudeAgentOptions(
                  allowed_tools=["Read", "Grep", "Glob", "Agent"],
                  # env is merged on top of the inherited environment
                  env={
                      "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1",
                      "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "5",
                  },
                  max_budget_usd=5.0,
              ),
          ):
              if isinstance(message, ResultMessage):
                  print(f"{message.subtype}: ${message.total_cost_usd}")
      except Exception as error:
          # A single-shot query() raises after yielding an error result,
          # so the budget-capped result has already been printed above.
          print(f"Session ended with an error: {error}")


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  try {
    for await (const message of query({
      prompt: "Audit every service in this repo for unhandled promise rejections",
      options: {
        allowedTools: ["Read", "Grep", "Glob", "Agent"],
        // env replaces the subprocess environment, so spread process.env to keep PATH
        env: {
          ...process.env,
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
          CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "5",
        },
        maxBudgetUsd: 5,
      },
    })) {
      if (message.type === "result") {
        console.log(`${message.subtype}: $${message.total_cost_usd}`);
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result,
    // so the budget-capped result has already been logged above.
    console.error(`Session ended with an error: ${error}`);
  }
  ```
</CodeGroup>

What you see depends on which limit, if any, the query reaches:

* **Under the spend cap**: you see `success` and the estimated cost.
* **At the spend cap**: you see `error_max_budget_usd` with a cost at or above `5`, and then your error handler runs.
* **At the concurrency limit**: you see a `tool_result` block in the message stream carrying `Concurrent subagent limit reached`. Claude receives the same block as the Agent tool's result.

### Run Opus 5 with subagents

Claude Opus 5 delegates to subagents more readily than earlier models, so the [depth, concurrency, and spend limits](#cap-subagent-depth-concurrency-and-spend) matter most on queries that run Opus 5. The [Opus 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5#controlling-subagent-spawning) has a delegation instruction you can add to any prompt. Whether Claude Code adds an instruction of its own depends on which [system prompt](/docs/en/agent-sdk/modifying-system-prompts#how-system-prompts-work) you use:

* **`claude_code` preset**: when the model is Opus 5, Claude Code adds a line to its system prompt telling Claude not to call the Agent tool unless it's asked to. The Agent tool stays available.
* **A custom prompt, or no `systemPrompt`**: Claude Code doesn't build its system prompt, so that line is absent. Add the prompting guide's delegation instruction to your own prompt.

Either instruction only steers Claude, so set the limits as well. Claude Code enforces them however Claude decides to delegate.

## Scale up with dynamic workflows

Subagents work well for a few delegated tasks per turn. For runs that coordinate dozens to hundreds of agents, use the `Workflow` tool, which moves the orchestration into a script the runtime executes outside the conversation context. See [dynamic workflows](/docs/en/workflows) for how workflows differ from turn-by-turn subagent delegation.

The `Workflow` tool is available in the TypeScript Agent SDK v0.3.149 and later. Include `Workflow` in `allowedTools` to auto-approve workflow runs. The tool input and output schemas are listed in the [TypeScript reference](/docs/en/agent-sdk/typescript#workflow).

## Troubleshooting

### Claude not delegating to subagents

If Claude completes tasks directly instead of delegating to your subagent:

* **Check Agent invocations are approved**: include `Agent` in `allowedTools` to auto-approve subagent calls. Without it, Agent invocations fall through to your `canUseTool` callback or, in `dontAsk` mode, are denied
* **Use explicit prompting**: mention the subagent by name in your prompt, for example "Use the code-reviewer agent to..."
* **Write a clear description**: explain exactly when to use the subagent so Claude can match tasks appropriately

### Filesystem-based agents not loading

Claude Code watches `~/.claude/agents/` and `.claude/agents/` and picks up a new or edited agent file within a few seconds, with no restart needed. If a definition never appears, work through these causes:

* **New `agents` directory**: the watcher covers only directories that existed when the session started, so the first file in a new directory needs a session restart. This is the most common cause.
* **Invalid frontmatter or a duplicate `name`**: check the file's YAML, and whether an existing agent already uses the `name`.
* **`--disable-slash-commands`**: sessions started with this flag don't watch these directories and always need a restart to load new files.
* **A file under an added directory**: Claude Code loads `.claude/agents/` from directories added with the `add_dirs` (Python) or `additionalDirectories` (TypeScript) option, or the CLI's `--add-dir` or `/add-dir`, but doesn't watch them, so a new or edited file there needs a session restart.
* **A programmatic agent with the same name**: `agents` passed to `query()` override a filesystem agent with the same name.

For the file format, see [how to write subagent files](/docs/en/sub-agents#write-subagent-files).

## Related documentation

* [Claude Code subagents](/docs/en/sub-agents): comprehensive subagent documentation including filesystem-based definitions
* [Dynamic workflows](/docs/en/workflows): orchestrate many subagents from a script for jobs too large for one conversation
* [SDK overview](/docs/en/agent-sdk/overview): getting started with the Claude Agent SDK
