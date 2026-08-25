> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Intercept and control agent behavior with hooks

> Intercept and customize agent behavior at key execution points with hooks

Hooks are callback functions that run your code in response to agent events, like a tool being called, a session starting, or execution stopping. With hooks, you can:

* **Block dangerous operations** before they execute, like destructive shell commands or unauthorized file access
* **Log and audit** every tool call for compliance, debugging, or analytics
* **Transform inputs and outputs** to sanitize data, inject credentials, or redirect file paths
* **Require human approval** for sensitive actions like database writes or API calls
* **Track session lifecycle** to manage state, clean up resources, or send notifications

## How hooks work

<Steps>
  <Step title="An event fires">
    Something happens during agent execution and the SDK fires an event: a tool is about to be called (`PreToolUse`), a tool returned a result (`PostToolUse`), a subagent started or stopped, the agent is idle, or execution finished. See the [full list of events](#available-hooks).
  </Step>

  <Step title="The SDK collects registered hooks">
    The SDK checks for hooks registered for that event type. This includes callback hooks you pass in `options.hooks` and shell command hooks from settings files when the corresponding [`settingSources`](/docs/en/agent-sdk/typescript#settingsource) or [`setting_sources`](/docs/en/agent-sdk/python#settingsource) entry is enabled, which it is for default `query()` options.
  </Step>

  <Step title="Matchers filter which hooks run">
    If a hook has a [`matcher`](#matchers) pattern (like `"Write|Edit"`), the SDK tests it against the event's target (for example, the tool name). Hooks without a matcher run for every event of that type.
  </Step>

  <Step title="Callback functions execute">
    Each matching hook's [callback function](#callback-functions) receives input about what's happening: the tool name, its arguments, the session ID, and other event-specific details.
  </Step>

  <Step title="Your callback returns a decision">
    After performing any operations (logging, API calls, validation), your callback returns an [output object](#outputs) that tells the agent what to do: allow the operation, block it, modify the input, or inject context into the conversation.
  </Step>
</Steps>

The following example puts these steps together. It registers a `PreToolUse` hook (step 1) with a `"Write|Edit"` matcher (step 3) so the callback only fires for file-writing tools. When triggered, the callback receives the tool's input (step 4), checks if the file path targets a `.env` file, and returns `permissionDecision: "deny"` to block the operation (step 5):

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import (
      AssistantMessage,
      ClaudeSDKClient,
      ClaudeAgentOptions,
      HookMatcher,
      ResultMessage,
  )


  # Define a hook callback that receives tool call details
  async def protect_env_files(input_data, tool_use_id, context):
      # Extract the file path from the tool's input arguments
      file_path = input_data["tool_input"].get("file_path", "")
      file_name = file_path.split("/")[-1]

      # Block the operation if targeting a .env file
      if file_name == ".env":
          return {
              "hookSpecificOutput": {
                  "hookEventName": input_data["hook_event_name"],
                  "permissionDecision": "deny",
                  "permissionDecisionReason": "Cannot modify .env files",
              }
          }

      # Return empty object to allow the operation
      return {}


  async def main():
      options = ClaudeAgentOptions(
          hooks={
              # Register the hook for PreToolUse events
              # The matcher filters to only Write and Edit tool calls
              "PreToolUse": [HookMatcher(matcher="Write|Edit", hooks=[protect_env_files])]
          }
      )

      async with ClaudeSDKClient(options=options) as client:
          await client.query("Create a .env file with the standard local development database configuration")
          async for message in client.receive_response():
              # Filter for assistant and result messages
              if isinstance(message, (AssistantMessage, ResultMessage)):
                  print(message)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query, HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

  // Define a hook callback with the HookCallback type
  const protectEnvFiles: HookCallback = async (input, toolUseID, { signal }) => {
    // Cast input to the specific hook type for type safety
    const preInput = input as PreToolUseHookInput;

    // Cast tool_input to access its properties (typed as unknown in the SDK)
    const toolInput = preInput.tool_input as Record<string, unknown>;
    const filePath = toolInput?.file_path as string;
    const fileName = filePath?.split("/").pop();

    // Block the operation if targeting a .env file
    if (fileName === ".env") {
      return {
        hookSpecificOutput: {
          hookEventName: preInput.hook_event_name,
          permissionDecision: "deny",
          permissionDecisionReason: "Cannot modify .env files"
        }
      };
    }

    // Return empty object to allow the operation
    return {};
  };

  for await (const message of query({
    prompt: "Create a .env file with the standard local development database configuration",
    options: {
      hooks: {
        // Register the hook for PreToolUse events
        // The matcher filters to only Write and Edit tool calls
        PreToolUse: [{ matcher: "Write|Edit", hooks: [protectEnvFiles] }]
      }
    }
  })) {
    // Filter for assistant and result messages
    if (message.type === "assistant" || message.type === "result") {
      console.log(message);
    }
  }
  ```
</CodeGroup>

When you run either script, Claude attempts to create the `.env` file, the hook denies the tool call, and Claude's final response explains that it can't create `.env` files.

## Available hooks

The SDK provides hooks for different stages of agent execution. Some hooks are available in both SDKs, while others are TypeScript-only.

| Hook Event                                             | Python SDK | TypeScript SDK | What triggers it                                                                                                                        | Example use case                                                                                                                                          |
| ------------------------------------------------------ | ---------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUse`                                           | Yes        | Yes            | Tool call request (can block or modify)                                                                                                 | Block dangerous shell commands                                                                                                                            |
| `PostToolUse`                                          | Yes        | Yes            | Tool execution result                                                                                                                   | Log all file changes to audit trail                                                                                                                       |
| `PostToolUseFailure`                                   | Yes        | Yes            | Tool execution failure                                                                                                                  | Handle or log tool errors                                                                                                                                 |
| `PostToolBatch`                                        | No         | Yes            | A full batch of tool calls resolves, once per batch before the next model call                                                          | Inject conventions once for the whole batch                                                                                                               |
| `UserPromptSubmit`                                     | Yes        | Yes            | User prompt submission                                                                                                                  | Inject additional context into prompts                                                                                                                    |
| [`UserPromptExpansion`](/docs/en/hooks#userpromptexpansion) | No         | Yes            | A user-typed command, or an MCP prompt, expands into a prompt before it reaches Claude. Doesn't fire when Claude invokes a skill itself | Block a command from direct invocation or add context when a skill is typed                                                                               |
| `MessageDisplay`                                       | No         | Yes            | An assistant message with text completes, once per message with the full message text                                                   | Redact or reformat the displayed text without changing the transcript                                                                                     |
| `Stop`                                                 | Yes        | Yes            | Agent execution stop                                                                                                                    | Save session state before exit                                                                                                                            |
| `StopFailure`                                          | No         | Yes            | The turn ends with an API error instead of a normal stop                                                                                | Log failures or send alerts                                                                                                                               |
| `SubagentStart`                                        | Yes        | Yes            | Subagent initialization                                                                                                                 | Track parallel task spawning                                                                                                                              |
| `SubagentStop`                                         | Yes        | Yes            | Subagent completion                                                                                                                     | Aggregate results from parallel tasks                                                                                                                     |
| `PreCompact`                                           | Yes        | Yes            | Conversation compaction request                                                                                                         | Archive full transcript before summarizing                                                                                                                |
| `PostCompact`                                          | No         | Yes            | Conversation compaction completes                                                                                                       | Log the generated summary                                                                                                                                 |
| `PermissionRequest`                                    | Yes        | Yes            | A tool call needs a permission decision                                                                                                 | Custom permission handling                                                                                                                                |
| `PermissionDenied`                                     | No         | Yes            | Auto mode denies a tool call, including denials without a classifier verdict                                                            | Log denials, or tell the model it may retry; Claude Code ignores `retry: true` for no-verdict denials. See [PermissionDenied](/docs/en/hooks#permissiondenied) |
| `SessionStart`                                         | No         | Yes            | Session initialization                                                                                                                  | Initialize logging and telemetry                                                                                                                          |
| `SessionEnd`                                           | No         | Yes            | Session termination                                                                                                                     | Clean up temporary resources                                                                                                                              |
| `Notification`                                         | Yes        | Yes            | Agent status messages                                                                                                                   | Send agent status updates to Slack or PagerDuty                                                                                                           |
| `Setup`                                                | No         | Yes            | Session setup/maintenance                                                                                                               | Run initialization tasks                                                                                                                                  |
| `TeammateIdle`                                         | No         | Yes            | Teammate becomes idle                                                                                                                   | Reassign work or notify                                                                                                                                   |
| `TaskCreated`                                          | No         | Yes            | A task is created via the `TaskCreate` tool                                                                                             | Enforce task naming conventions                                                                                                                           |
| [`TaskCompleted`](/docs/en/hooks#taskcompleted)             | No         | Yes            | A task is marked completed                                                                                                              | Require passing tests before a task closes                                                                                                                |
| `Elicitation`                                          | No         | Yes            | An MCP server requests user input mid-task                                                                                              | Respond to MCP input requests programmatically                                                                                                            |
| `ElicitationResult`                                    | No         | Yes            | A user responds to an MCP elicitation                                                                                                   | Modify or block the response before it returns to the server                                                                                              |
| `ConfigChange`                                         | No         | Yes            | Configuration file changes                                                                                                              | Reload settings dynamically                                                                                                                               |
| `InstructionsLoaded`                                   | No         | Yes            | A `CLAUDE.md` or rules file is loaded into context                                                                                      | Audit which instruction files load                                                                                                                        |
| `WorktreeCreate`                                       | No         | Yes            | Git worktree created                                                                                                                    | Track isolated workspaces                                                                                                                                 |
| `WorktreeRemove`                                       | No         | Yes            | Git worktree removed                                                                                                                    | Clean up workspace resources                                                                                                                              |
| `CwdChanged`                                           | No         | Yes            | The working directory changes during a session                                                                                          | Reload environment variables per directory                                                                                                                |
| `FileChanged`                                          | No         | Yes            | A watched file is modified, created, or deleted                                                                                         | Reload configuration when project files change                                                                                                            |
| `DirectoryAdded`                                       | No         | Yes            | A working directory is added during a session                                                                                           | Install dependencies for a repository added mid-session                                                                                                   |

## Configure hooks

To configure a hook, pass it in the `hooks` field of your agent options (`ClaudeAgentOptions` in Python, the `options` object in TypeScript). This snippet assumes you have already defined a hook callback, like `protect_env_files` in Python or `protectEnvFiles` in TypeScript from the example above:

<CodeGroup>
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      hooks={"PreToolUse": [HookMatcher(matcher="Bash", hooks=[my_callback])]}
  )

  async with ClaudeSDKClient(options=options) as client:
      await client.query("Your prompt")
      async for message in client.receive_response():
          print(message)
  ```

  ```typescript TypeScript theme={null}
  for await (const message of query({
    prompt: "Your prompt",
    options: {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [myCallback] }]
      }
    }
  })) {
    console.log(message);
  }
  ```
</CodeGroup>

The `hooks` option is a dictionary in Python or an object in TypeScript, where:

* **Keys**: [hook event names](#available-hooks) such as `'PreToolUse'`, `'PostToolUse'`, and `'Stop'`
* **Values**: arrays of [matchers](#matchers), each containing an optional filter pattern and your [callback functions](#callback-functions)

### Matchers

Use matchers to filter when your callbacks fire. The `matcher` field matches against a different value depending on the hook event type. For example, tool-based hooks match against the tool name, while `Notification` hooks match against the notification type.

SDK matchers follow the same rules as [matchers in settings files](/docs/en/hooks#matcher-patterns). That section documents the exact-string and regular-expression evaluation paths, their version requirements, and the matcher values for each event type.

| Option    | Type             | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matcher` | `string`         | `undefined` | Pattern matched against the event's filter field, following the [rules for matchers in settings files](/docs/en/hooks#matcher-patterns). For tool hooks, this is the tool name. Built-in tools include `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `Agent`, and others (see [Tool Input Types](/docs/en/agent-sdk/typescript#tool-input-types) for the full list). MCP tools use the pattern `mcp__<server>__<action>`, where `<server>` is the key you use in the `mcpServers` configuration. |
| `hooks`   | `HookCallback[]` | -           | Required. Array of callback functions to execute when the pattern matches                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `timeout` | `number`         | `undefined` | Timeout in seconds. When omitted, Claude Code applies the [event's default timeout](#hook-timeout). Your SDK callbacks follow the `command` hook defaults                                                                                                                                                                                                                                                                                                                                             |

Use the `matcher` pattern to target specific tools whenever possible. A matcher with `'Bash'` only runs for Bash commands, while omitting the pattern runs your callbacks for every occurrence of the event. Omit it on purpose to log every tool call your session makes.

### Callback functions

#### Inputs

Every hook callback receives three arguments:

* **Input data:** a typed object containing event details. Each hook type has its own input shape. For example, `PreToolUseHookInput` includes `tool_name` and `tool_input`, while `NotificationHookInput` includes `message`. See the full type definitions in the [TypeScript](/docs/en/agent-sdk/typescript#hookinput) and [Python](/docs/en/agent-sdk/python#hookinput) SDK references.
  * All hook inputs share `session_id`, `cwd`, and `hook_event_name`.
  * `agent_id` and `agent_type` are populated when the hook fires inside a subagent. In TypeScript, these are on the base hook input and available to all hook types. In Python, they are optional fields on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `PermissionRequest`, and required fields on `SubagentStart` and `SubagentStop`.
* **Tool use ID** (`str | None` / `string | undefined`): correlates `PreToolUse` and `PostToolUse` events for the same tool call.
* **Context:** in TypeScript, contains a `signal` property (`AbortSignal`) for cancellation. In Python, this argument is reserved for future use.

#### Outputs

Your callback returns an object with two categories of fields:

* **Top-level fields** are accepted on every event: `systemMessage` shows a message to the user, and `continue` (`continue_` in Python) determines whether the agent keeps running after this hook. Some events discard them or deliver them elsewhere. Each [event's section](/docs/en/hooks#hook-events) on the hooks page says where they land.
* **`hookSpecificOutput`** controls the current operation. The fields you set inside depend on the hook event type:
  * For `PreToolUse` hooks, this is where you set `permissionDecision` (`"allow"`, `"deny"`, `"ask"`, or `"defer"`), `permissionDecisionReason`, and `updatedInput`. If you return `"defer"`, the query ends so you can [resume it later](/docs/en/hooks#defer-a-tool-call-for-later).
  * For `PostToolUse` hooks, you can set `additionalContext` to append information to the tool result. To replace the tool's output before Claude sees it, set `updatedToolOutput`, which works for any tool in both SDKs. The older `updatedMCPToolOutput` field replaces MCP tool output only and is deprecated.
  * In the TypeScript SDK, a `PostToolUse` callback can also return `classifierContext`, a short note about the tool call's result for the [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) permission classifier. Because your callback runs in your application's own process, the classifier may weigh a user statement you relay in the note as user intent. The field requires TypeScript Agent SDK v0.3.236 or later. [Annotate a result for the auto mode classifier](/docs/en/hooks#annotate-a-result-for-the-auto-mode-classifier) covers the length cap, the synchronous-only rule, and what not to put in the note.

Return `{}` to allow the operation without changes. SDK callback hooks use the same JSON output format as [Claude Code shell command hooks](/docs/en/hooks#json-output), which documents every field and event-specific option. For the SDK type definitions, see the [TypeScript](/docs/en/agent-sdk/typescript#synchookjsonoutput) and [Python](/docs/en/agent-sdk/python#synchookjsonoutput) SDK references.

<Note>
  When multiple hooks or permission rules apply, `deny` takes priority over `defer`, which takes priority over `ask`, which takes priority over `allow`. If any hook returns `deny`, the operation is blocked regardless of other hooks.
</Note>

#### Asynchronous output

By default, the agent waits for your hook to return before proceeding. If your hook performs a side effect, such as logging or sending a webhook, and doesn't need to influence the agent's behavior, you can return an async output instead. This tells the agent to continue immediately without waiting for the hook to finish. In this snippet, `send_to_logging_service` in Python and `sendToLoggingService` in TypeScript stand in for any logging function you define:

<CodeGroup>
  ```python Python theme={null}
  async def async_hook(input_data, tool_use_id, context):
      # Start a background task, then return immediately
      asyncio.create_task(send_to_logging_service(input_data))
      return {"async_": True, "asyncTimeout": 30000}
  ```

  ```typescript TypeScript theme={null}
  const asyncHook: HookCallback = async (input, toolUseID, { signal }) => {
    // Start a background task, then return immediately
    sendToLoggingService(input).catch(console.error);
    return { async: true, asyncTimeout: 30000 };
  };
  ```
</CodeGroup>

| Field          | Type     | Description                                                                                                    |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `async`        | `true`   | Signals async mode. The agent proceeds without waiting. In Python, use `async_` to avoid the reserved keyword. |
| `asyncTimeout` | `number` | Optional timeout in milliseconds for the background operation                                                  |

<Note>
  Async outputs can't block, modify, or inject context into the operation since the agent has already moved on. Use them only for side effects like logging, metrics, or notifications.
</Note>

## Examples

Several examples in this section show only the callback function. To run one, register the callback under the matching event in the `hooks` field of your options, as shown in [Configure hooks](#configure-hooks).

### Modify tool input

This example intercepts Write tool calls and rewrites the `file_path` argument to prepend `/sandbox`, redirecting all file writes to a sandboxed directory. The callback returns `updatedInput` with the modified path and `permissionDecision: 'allow'` to auto-approve the rewritten operation:

<CodeGroup>
  ```python Python theme={null}
  async def redirect_to_sandbox(input_data, tool_use_id, context):
      if input_data["hook_event_name"] != "PreToolUse":
          return {}

      if input_data["tool_name"] == "Write":
          original_path = input_data["tool_input"].get("file_path", "")
          return {
              "hookSpecificOutput": {
                  "hookEventName": input_data["hook_event_name"],
                  "permissionDecision": "allow",
                  "updatedInput": {
                      **input_data["tool_input"],
                      "file_path": f"/sandbox{original_path}",
                  },
              }
          }
      return {}
  ```

  ```typescript TypeScript theme={null}
  const redirectToSandbox: HookCallback = async (input, toolUseID, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {};

    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown>;
    if (preInput.tool_name === "Write") {
      const originalPath = toolInput.file_path as string;
      return {
        hookSpecificOutput: {
          hookEventName: preInput.hook_event_name,
          permissionDecision: "allow",
          updatedInput: {
            ...toolInput,
            file_path: `/sandbox${originalPath}`
          }
        }
      };
    }
    return {};
  };
  ```
</CodeGroup>

<Note>
  Pair `updatedInput` with `permissionDecision: 'allow'` to auto-approve the modified input, or `permissionDecision: 'ask'` to show it to the user. If you omit `permissionDecision`, the modified input still applies and flows through the normal permission evaluation. With `'defer'`, `updatedInput` is ignored. Always return a new object rather than mutating the original `tool_input`.
</Note>

To confirm the redirect, set the prefix to a path you can write to, such as `./sandbox` or `/tmp/sandbox` (macOS doesn't allow creating a root-level `/sandbox` directory), then ask the agent to write a file: the Write tool's result in the message stream names the path with your sandbox prefix rather than the one Claude requested.

### Add context and block a tool

This example blocks writes to the `/etc` directory and explains why to both the model and the user:

* `permissionDecision: 'deny'` stops the tool call.
* `permissionDecisionReason` tells the model why, so it avoids retrying.
* `systemMessage` shows the user what happened.

<CodeGroup>
  ```python Python theme={null}
  async def block_etc_writes(input_data, tool_use_id, context):
      file_path = input_data["tool_input"].get("file_path", "")

      if file_path.startswith("/etc"):
          return {
              # Top-level field: message shown to the user
              "systemMessage": "Remember: system directories like /etc are protected.",
              # hookSpecificOutput: block the operation
              "hookSpecificOutput": {
                  "hookEventName": input_data["hook_event_name"],
                  "permissionDecision": "deny",
                  "permissionDecisionReason": "Writing to /etc is not allowed",
              },
          }
      return {}
  ```

  ```typescript TypeScript theme={null}
  const blockEtcWrites: HookCallback = async (input, toolUseID, { signal }) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown>;
    const filePath = toolInput?.file_path as string;

    if (filePath?.startsWith("/etc")) {
      return {
        // Top-level field: message shown to the user
        systemMessage: "Remember: system directories like /etc are protected.",
        // hookSpecificOutput: block the operation
        hookSpecificOutput: {
          hookEventName: preInput.hook_event_name,
          permissionDecision: "deny",
          permissionDecisionReason: "Writing to /etc is not allowed"
        }
      };
    }
    return {};
  };
  ```
</CodeGroup>

### Auto-approve specific tools

By default, the agent may prompt for permission before using certain tools. This example auto-approves read-only filesystem tools (Read, Glob, Grep) by returning `permissionDecision: 'allow'`, letting them run without user confirmation while leaving all other tools subject to normal permission checks:

<CodeGroup>
  ```python Python theme={null}
  async def auto_approve_read_only(input_data, tool_use_id, context):
      if input_data["hook_event_name"] != "PreToolUse":
          return {}

      read_only_tools = ["Read", "Glob", "Grep"]
      if input_data["tool_name"] in read_only_tools:
          return {
              "hookSpecificOutput": {
                  "hookEventName": input_data["hook_event_name"],
                  "permissionDecision": "allow",
                  "permissionDecisionReason": "Read-only tool auto-approved",
              }
          }
      return {}
  ```

  ```typescript TypeScript theme={null}
  const autoApproveReadOnly: HookCallback = async (input, toolUseID, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {};

    const preInput = input as PreToolUseHookInput;
    const readOnlyTools = ["Read", "Glob", "Grep"];
    if (readOnlyTools.includes(preInput.tool_name)) {
      return {
        hookSpecificOutput: {
          hookEventName: preInput.hook_event_name,
          permissionDecision: "allow",
          permissionDecisionReason: "Read-only tool auto-approved"
        }
      };
    }
    return {};
  };
  ```
</CodeGroup>

### Register multiple hooks

When an event fires, all matching hooks run in parallel. For permission decisions, the most restrictive result applies: a single `deny` blocks the tool call regardless of what the other hooks return. Because completion order is non-deterministic, write each hook to act independently rather than relying on another hook having run first.

The example below registers three independent checks for every tool call:

<CodeGroup>
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      hooks={
          "PreToolUse": [
              HookMatcher(hooks=[authorization_check]),
              HookMatcher(hooks=[input_validator]),
              HookMatcher(hooks=[audit_logger]),
          ]
      }
  )
  ```

  ```typescript TypeScript theme={null}
  const options = {
    hooks: {
      PreToolUse: [
        { hooks: [authorizationCheck] },
        { hooks: [inputValidator] },
        { hooks: [auditLogger] }
      ]
    }
  };
  ```
</CodeGroup>

### Filter with multi-tool matchers

Use multi-tool matchers to share one callback across related tools. This example registers three matchers with different scopes:

* A pipe-separated exact list (`Write|Edit|NotebookEdit`) triggers `file_security_hook` only for file modification tools.
* A regex (`^mcp__`) triggers `mcp_audit_hook` for any MCP tool whose name starts with `mcp__`.
* An omitted matcher triggers `global_logger` for every tool call regardless of name.

<CodeGroup>
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      hooks={
          "PreToolUse": [
              # Match file modification tools
              HookMatcher(matcher="Write|Edit|NotebookEdit", hooks=[file_security_hook]),
              # Match all MCP tools
              HookMatcher(matcher="^mcp__", hooks=[mcp_audit_hook]),
              # Match everything (no matcher)
              HookMatcher(hooks=[global_logger]),
          ]
      }
  )
  ```

  ```typescript TypeScript theme={null}
  const options = {
    hooks: {
      PreToolUse: [
        // Match file modification tools
        { matcher: "Write|Edit|NotebookEdit", hooks: [fileSecurityHook] },

        // Match all MCP tools
        { matcher: "^mcp__", hooks: [mcpAuditHook] },

        // Match everything (no matcher)
        { hooks: [globalLogger] }
      ]
    }
  };
  ```
</CodeGroup>

### Track subagent activity

Use `SubagentStop` hooks to monitor when subagents finish their work. See the full input type in the [TypeScript](/docs/en/agent-sdk/typescript#hookinput) and [Python](/docs/en/agent-sdk/python#hookinput) SDK references. This example logs a summary each time a subagent completes:

<CodeGroup>
  ```python Python theme={null}
  async def subagent_tracker(input_data, tool_use_id, context):
      # Log subagent details when it finishes
      print(f"[SUBAGENT] Completed: {input_data['agent_id']}")
      print(f"  Transcript: {input_data['agent_transcript_path']}")
      print(f"  Tool use ID: {tool_use_id}")
      print(f"  Stop hook active: {input_data.get('stop_hook_active')}")
      return {}


  options = ClaudeAgentOptions(
      hooks={"SubagentStop": [HookMatcher(hooks=[subagent_tracker])]}
  )
  ```

  ```typescript TypeScript theme={null}
  import { HookCallback, SubagentStopHookInput } from "@anthropic-ai/claude-agent-sdk";

  const subagentTracker: HookCallback = async (input, toolUseID, { signal }) => {
    // Cast to SubagentStopHookInput to access subagent-specific fields
    const subInput = input as SubagentStopHookInput;

    // Log subagent details when it finishes
    console.log(`[SUBAGENT] Completed: ${subInput.agent_id}`);
    console.log(`  Transcript: ${subInput.agent_transcript_path}`);
    console.log(`  Tool use ID: ${toolUseID}`);
    console.log(`  Stop hook active: ${subInput.stop_hook_active}`);
    return {};
  };

  const options = {
    hooks: {
      SubagentStop: [{ hooks: [subagentTracker] }]
    }
  };
  ```
</CodeGroup>

### Make HTTP requests from hooks

Hooks can perform asynchronous operations like HTTP requests. Catch errors inside your hook instead of letting them propagate, since an unhandled exception can interrupt the agent.

This example sends a webhook after each tool completes, logging which tool ran and when. The hook catches errors so a failed webhook doesn't interrupt the agent:

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  import json
  import urllib.request
  from datetime import datetime


  def _send_webhook(tool_name):
      """Synchronous helper that POSTs tool usage data to an external webhook."""
      data = json.dumps(
          {
              "tool": tool_name,
              "timestamp": datetime.now().isoformat(),
          }
      ).encode()
      req = urllib.request.Request(
          "https://api.example.com/webhook",
          data=data,
          headers={"Content-Type": "application/json"},
          method="POST",
      )
      urllib.request.urlopen(req)


  async def webhook_notifier(input_data, tool_use_id, context):
      # Only fire after a tool completes (PostToolUse), not before
      if input_data["hook_event_name"] != "PostToolUse":
          return {}

      try:
          # Run the blocking HTTP call in a thread to avoid blocking the event loop
          await asyncio.to_thread(_send_webhook, input_data["tool_name"])
      except Exception as e:
          # Log the error but don't raise. A failed webhook shouldn't stop the agent
          print(f"Webhook request failed: {e}")

      return {}
  ```

  ```typescript TypeScript theme={null}
  import { query, HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

  const webhookNotifier: HookCallback = async (input, toolUseID, { signal }) => {
    // Only fire after a tool completes (PostToolUse), not before
    if (input.hook_event_name !== "PostToolUse") return {};

    try {
      await fetch("https://api.example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: (input as PostToolUseHookInput).tool_name,
          timestamp: new Date().toISOString()
        }),
        // Pass signal so the request cancels if the hook times out
        signal
      });
    } catch (error) {
      // Handle cancellation separately from other errors
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Webhook request cancelled");
      }
      // Don't re-throw. A failed webhook shouldn't stop the agent
    }

    return {};
  };

  // Register as a PostToolUse hook
  for await (const message of query({
    prompt: "Refactor the auth module",
    options: {
      hooks: {
        PostToolUse: [{ hooks: [webhookNotifier] }]
      }
    }
  })) {
    console.log(message);
  }
  ```
</CodeGroup>

To confirm the hook fires, point the webhook URL at an endpoint you can watch and send a prompt that uses a tool: the hook sends a POST with the tool name and timestamp after each tool completes.

### Forward notifications to Slack

Use `Notification` hooks to receive system notifications from the agent and forward them to external services. In SDK sessions, Claude Code runs this hook for the following notification types:

* [`permission_prompt`](/docs/en/hooks#notification) once a permission request has waited about six seconds on your [`canUseTool` callback](/docs/en/agent-sdk/user-input). Requires TypeScript Agent SDK v0.3.233 or later, or Python Agent SDK v0.2.139 or later
* `elicitation_complete` and `elicitation_response` for user-prompt elicitation flows

Claude Code emits the other types, such as `idle_prompt`, `auth_success`, and `elicitation_dialog`, from interactive UI that SDK sessions don't run.

Each notification includes a `message` field with a human-readable description and optionally a `title`.

This example forwards every notification to a Slack channel. It requires a [Slack incoming webhook URL](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/), which you create by adding an app to your Slack workspace and enabling incoming webhooks:

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  import json
  import urllib.request

  from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions, HookMatcher


  def _send_slack_notification(message):
      """Synchronous helper that sends a message to Slack via incoming webhook."""
      data = json.dumps({"text": f"Agent status: {message}"}).encode()
      req = urllib.request.Request(
          "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
          data=data,
          headers={"Content-Type": "application/json"},
          method="POST",
      )
      urllib.request.urlopen(req)


  async def notification_handler(input_data, tool_use_id, context):
      try:
          # Run the blocking HTTP call in a thread to avoid blocking the event loop
          await asyncio.to_thread(_send_slack_notification, input_data.get("message", ""))
      except Exception as e:
          print(f"Failed to send notification: {e}")

      # Return empty object. Notification hooks don't modify agent behavior
      return {}


  async def main():
      options = ClaudeAgentOptions(
          hooks={
              # Register the hook for Notification events (no matcher needed)
              "Notification": [HookMatcher(hooks=[notification_handler])],
          },
      )

      async with ClaudeSDKClient(options=options) as client:
          await client.query("Analyze this codebase")
          async for message in client.receive_response():
              print(message)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query, HookCallback, NotificationHookInput } from "@anthropic-ai/claude-agent-sdk";

  // Define a hook callback that sends notifications to Slack
  const notificationHandler: HookCallback = async (input, toolUseID, { signal }) => {
    // Cast to NotificationHookInput to access the message field
    const notification = input as NotificationHookInput;

    try {
      // POST the notification message to a Slack incoming webhook
      await fetch("https://hooks.slack.com/services/YOUR/WEBHOOK/URL", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Agent status: ${notification.message}`
        }),
        // Pass signal so the request cancels if the hook times out
        signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Notification cancelled");
      } else {
        console.error("Failed to send notification:", error);
      }
    }

    // Return empty object. Notification hooks don't modify agent behavior
    return {};
  };

  // Register the hook for Notification events (no matcher needed)
  for await (const message of query({
    prompt: "Analyze this codebase",
    options: {
      hooks: {
        Notification: [{ hooks: [notificationHandler] }]
      }
    }
  })) {
    console.log(message);
  }
  ```
</CodeGroup>

When a `Notification` event fires, the hook posts the notification's `message`, prefixed with `Agent status:`, to the channel your webhook targets.

## Fix common issues

### Hook not firing

* Verify the hook event name is correct and case-sensitive (`PreToolUse`, not `preToolUse`)
* Check that your matcher pattern matches the tool name exactly
* Ensure the hook is under the correct event type in `options.hooks`
* For non-tool hooks that support matchers, like `Notification` and `SubagentStop`, matchers match against different fields, and `Stop` ignores matchers entirely (see [matcher patterns](/docs/en/hooks#matcher-patterns))
* Hooks may not fire when the agent hits the [`max_turns`](/docs/en/agent-sdk/python#claudeagentoptions) limit because the session ends before hooks can execute

### Matcher not filtering as expected

Matchers only match tool names, not file paths or other arguments. To filter by file path, check `tool_input.file_path` inside your hook:

```typescript theme={null}
const myHook: HookCallback = async (input, toolUseID, { signal }) => {
  const preInput = input as PreToolUseHookInput;
  const toolInput = preInput.tool_input as Record<string, unknown>;
  const filePath = toolInput?.file_path as string;
  if (!filePath?.endsWith(".md")) return {}; // Skip non-markdown files
  // Process markdown files...
  return {};
};
```

### Hook timeout

Claude Code runs each callback with a timeout, which you set in seconds with the `timeout` field on its `HookMatcher`. When you don't set one, Claude Code uses the event's default: 600 seconds for most events, 30 seconds for `UserPromptSubmit`, and 10 seconds for `MessageDisplay`. Claude Code runs `SessionEnd` callbacks during shutdown under the shorter [SessionEnd timeout budget](/docs/en/hooks#sessionend-input), 1.5 seconds by default.

When a callback exceeds its timeout, Claude Code cancels it and treats it as a failed hook: it discards the callback's output and the session continues rather than hanging. What happens next depends on the event:

* `PreToolUse`: Claude Code doesn't run the tool call, Claude receives a tool result stating the hook didn't respond before its timeout, and the turn continues. If another `PreToolUse` hook returned an explicit deny, Claude receives that denial instead of the timeout error. Before v2.1.210, Claude Code reported the timeout to Claude as a user rejection, which made unattended sessions stop and wait for input.
* `PostToolUse` and `PostToolUseFailure`: Claude Code keeps the tool result and the turn continues.
* `UserPromptSubmit` and [`UserPromptExpansion`](/docs/en/hooks#userpromptexpansion): Claude Code blocks the prompt with a message naming the hook and the timeout, and the session continues. Because a callback on these events can act as a policy gate, Claude Code never lets a timed-out prompt through unscreened. Before v2.1.208, Claude Code ended the query with `error_during_execution` when a callback on these events timed out.
* `Stop` and `SubagentStop`: Claude Code shows a warning and the agent stops normally.
* Other events, such as `Notification` and `PreCompact`: Claude Code logs the failure and continues.

If you interrupt the query while a callback is pending, Claude Code cancels the pending tool call. Before v2.1.208, the tool call could still proceed if you interrupted during a pending `PreToolUse` callback.

If your callback needs more time, set a higher `timeout` on its `HookMatcher`. In TypeScript, use the `AbortSignal` from the third callback argument to handle cancellation gracefully when the timeout fires.

### Tool blocked unexpectedly

* Check all `PreToolUse` hooks for `permissionDecision: 'deny'` returns
* Add logging to your hooks to see what `permissionDecisionReason` they're returning
* Verify matcher patterns aren't too broad: an empty matcher matches all tools

### Modified input not applied

* Ensure `updatedInput` is inside `hookSpecificOutput`, not at the top level:

  ```typescript theme={null}
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "new command" }
    }
  };
  ```

* Don't pair `updatedInput` with `permissionDecision: 'defer'`, which drops the modified input. Omitting `permissionDecision` is fine: the modified input still applies through the normal permission evaluation. You can also return `'allow'` to auto-approve the modified input or `'ask'` to show it to the user for approval

* Include `hookEventName` in `hookSpecificOutput` to identify which hook type the output is for

### Session hooks not available in Python

`SessionStart` and `SessionEnd` can be registered as SDK callback hooks in TypeScript, but aren't available in the Python SDK because its `HookEvent` type omits them. In Python, they are only available as [shell command hooks](/docs/en/hooks#hook-events) defined in settings files such as `.claude/settings.json`. To load shell command hooks from your SDK application, include the appropriate setting source with [`setting_sources`](/docs/en/agent-sdk/python#settingsource) or [`settingSources`](/docs/en/agent-sdk/typescript#settingsource):

<CodeGroup>
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      setting_sources=["project"],  # Loads .claude/settings.json including hooks
  )
  ```

  ```typescript TypeScript theme={null}
  const options = {
    settingSources: ["project"] // Loads .claude/settings.json including hooks
  };
  ```
</CodeGroup>

To run initialization logic as a Python SDK callback instead, use the first message from `client.receive_response()` as your trigger.

### Subagent permission prompts multiplying

When spawning multiple subagents, each one may request permissions separately for its own tool calls. To avoid repeated prompts, use `PreToolUse` hooks to auto-approve specific tools, or configure permission rules, which subagents [inherit from the parent conversation](/docs/en/sub-agents#permission-modes).

### Recursive hook loops with subagents

A `UserPromptSubmit` hook that spawns subagents can create infinite loops if those subagents trigger the same hook. To prevent this:

* Check for a subagent indicator in the hook input before spawning
* Use a shared variable or session state to track whether you're already inside a subagent
* Scope hooks to only run for the top-level agent session

### systemMessage not appearing in output

The `systemMessage` field shows a message to the user, not the model. On Claude Code v2.1.227 or later, a hook's `systemMessage` can surface in the message stream as an [`SDKInformationalMessage`](/docs/en/agent-sdk/typescript#sdkinformationalmessage). Whether it does depends on the event. Each [event's section](/docs/en/hooks#hook-events) on the hooks page says how output surfaces. To pass context to the model instead, return [`additionalContext`](/docs/en/hooks#add-context-for-claude).

Before v2.1.227, the SDK surfaced hook output in the message stream only for `SessionStart` and `Setup` hooks. For any other event, the output appeared only in the lifecycle events that [`includeHookEvents`](/docs/en/agent-sdk/typescript#options) (`include_hook_events` in Python) adds. That option's entry covers which lifecycle events each hook event produces.

If you need to surface hook decisions to your application reliably, log them separately or use a dedicated output channel.

## Related resources

* [Claude Code hooks reference](/docs/en/hooks): full JSON input/output schemas, event documentation, and matcher patterns
* [Claude Code hooks guide](/docs/en/hooks-guide): shell command hook examples and walkthroughs
* [TypeScript SDK reference](/docs/en/agent-sdk/typescript): hook types, input/output definitions, and configuration options
* [Python SDK reference](/docs/en/agent-sdk/python): hook types, input/output definitions, and configuration options
* [Permissions](/docs/en/agent-sdk/permissions): control what your agent can do
* [Custom tools](/docs/en/agent-sdk/custom-tools): build tools to extend agent capabilities
