> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Track todos

> Track todos in Agent SDK sessions and render Claude's progress in your application from structured tool calls

On the models listed under [Model availability](#model-availability), Claude tracks multi-step work without a written todo list, and Claude Code leaves the [task-tracking tools](/docs/en/tools-reference#task-tool-availability) out of sessions by default. You don't need anything on this page for Claude to work through multi-step tasks on those models.

In a session that has the task-tracking tools, Claude keeps a written todo list, updating each item's status as it works. You see each change in the message stream as a structured tool call. Opt a session in only when your application reads those tool calls, whether to log task activity or to render its own progress display.

## Model availability

<Note>
  On TypeScript Agent SDK 0.3.233 and later, or Python Agent SDK 0.2.139 and later, the following tools aren't available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, or later versions of those families unless you opt in:

  * `TodoWrite`
  * `TaskCreate`
  * `TaskGet`
  * `TaskUpdate`
  * `TaskList`

  On other models, Claude Code provides the Task tools by default and `TodoWrite` only when you set `CLAUDE_CODE_ENABLE_TASKS=0`.
</Note>

On the listed models, unless you opt a session in, you see no `tool_use` blocks for the tools in the message stream. The Agent SDK applies these defaults through the Claude Code binary that it bundles. If you point `pathToClaudeCodeExecutable` (TypeScript) or `cli_path` (Python) at your own Claude Code install, you get whichever tools that install provides, under its own defaults. To see the exact set in a running session, [check which tools are available](/docs/en/tools-reference#check-which-tools-are-available). To opt a session in, do one of the following:

* Name one of the tools in the [`allowedTools`](/docs/en/agent-sdk/permissions#allow-and-deny-rules) (TypeScript) or `allowed_tools` (Python) option
* List the tools in the `tools` option, which restricts the session's built-in tools to the ones it names. Include the tools you want alongside the other built-in tools you use
* Set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the `env` option, as the examples on this page do. In TypeScript, `env` replaces the subprocess environment, so spread `...process.env` to keep inherited variables. In Python, `env` is merged on top of the inherited environment

## Todo lifecycle

Claude moves each todo through a predictable lifecycle:

1. **Created**: Claude adds the todo as `pending` when it identifies a task
2. **Activated**: Claude sets the todo to `in_progress` when it starts the work
3. **Completed**: Claude marks it completed when the task finishes successfully
4. **Removed**: Claude deletes a todo it no longer needs by setting `status: "deleted"` in a `TaskUpdate` call

## When Claude creates todos

In a [session that has the task-tracking tools](#model-availability), Claude creates todos for most multi-step work, such as:

* **Complex multi-step tasks** requiring three or more distinct actions
* **User-provided task lists** when multiple items are mentioned
* **Longer operations** that benefit from progress tracking
* **Explicit requests** when users ask for todo organization

Claude may skip todos for very short or single-step requests.

## Examples

Before running these examples, install the Claude Agent SDK by following the [quickstart](/docs/en/agent-sdk/quickstart). Every example on this page shares the same permission setup and exit behavior:

* **Permission mode**: the example prompts ask Claude to do real work on a project, so each example sets `permissionMode: "acceptEdits"` (TypeScript) or `permission_mode="acceptEdits"` (Python) to auto-approve the file edits that work produces. See [Permission modes](/docs/en/agent-sdk/permissions#permission-modes) for the alternatives.
* **Turn limit**: each example runs until the agent finishes and yields its final result message. If a session reaches its turn limit first, that result message has the `error_max_turns` subtype. Check `subtype` to detect that ending.
* **Error handling**: these examples use single-shot `query()` calls. After yielding an `error_max_turns` result, `query()` raises an error that includes `Reached maximum number of turns`. Each example wraps its loop in a try block to exit cleanly when that happens. See [Handle the result](/docs/en/agent-sdk/agent-loop#handle-the-result) for the result subtypes.

<Note>
  The task system messages, [`SDKTaskNotificationMessage`](/docs/en/agent-sdk/typescript#sdktasknotificationmessage) (TypeScript) or [`TaskNotificationMessage`](/docs/en/agent-sdk/python#tasknotificationmessage) (Python) among them, report background tasks such as backgrounded commands and subagents. In the message stream, you see todo activity as `tool_use` blocks in the assistant messages.
</Note>

### Monitor todo changes

The following example watches the assistant stream for `TaskCreate` and `TaskUpdate` `tool_use` blocks and prints a `+` line with each new task's subject and an update line with each status change's task ID and new status. Use this shape when you want a log of task activity rather than a rendered display. The `+` lines don't include the assigned IDs, so this log can't match updates back to their creates. To keep that correlation, capture the IDs as [Display progress in real time](#display-progress-in-real-time) does.

The streamed `tool_use` input is the raw shape the model emitted. Claude Code repairs some close-but-incorrect key names before execution, mapping `id` or `task_id` to `taskId` and `active_form` to `activeForm`, but that repair is not reflected in the stream. Read `TaskUpdate` input fields defensively, as both examples on this page do, rather than assuming the canonical name is always present.

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  try {
    for await (const message of query({
      prompt: "Optimize my React app performance and track progress with todos",
      // Keeps the Task tools on models where Claude Code otherwise doesn't provide them.
      options: { maxTurns: 15, permissionMode: "acceptEdits", env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } },
    })) {
      if (message.type !== "assistant") continue;
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "TaskCreate") {
          const input = block.input as { subject: string };
          console.log(`+ ${input.subject}`);
        } else if (block.name === "TaskUpdate") {
          const input = block.input as {
            taskId?: string;
            id?: string;
            task_id?: string;
            status?: string;
          };
          const taskId = input.taskId ?? input.id ?? input.task_id;
          if (taskId && input.status) console.log(`  ${taskId} -> ${input.status}`);
        }
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result.
    console.log(`Session ended with an error: ${error}`);
  }
  ```

  ```python Python theme={null}
  import asyncio

  from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, ToolUseBlock

  async def main():
      try:
          async for message in query(
              prompt="Optimize my React app performance and track progress with todos",
              # Keeps the Task tools on models where Claude Code otherwise doesn't provide them.
              options=ClaudeAgentOptions(max_turns=15, permission_mode="acceptEdits", env={"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}),
          ):
              if not isinstance(message, AssistantMessage):
                  continue
              for block in message.content:
                  if not isinstance(block, ToolUseBlock):
                      continue
                  if block.name == "TaskCreate":
                      print(f"+ {block.input.get('subject', '')}")
                  elif block.name == "TaskUpdate" and block.input.get("status"):
                      task_id = (
                          block.input.get("taskId")
                          or block.input.get("id")
                          or block.input.get("task_id")
                      )
                      if task_id:
                          print(f"  {task_id} -> {block.input['status']}")
      except Exception as error:
          # A single-shot query() raises after yielding an error result.
          print(f"Session ended with an error: {error}")


  asyncio.run(main())
  ```
</CodeGroup>

### Display progress in real time

The following example watches the assistant stream for `TaskCreate` and `TaskUpdate` `tool_use` blocks and keeps a map of tasks keyed by task ID in a `TaskTracker` class, rerendering a progress summary on every change. The summary counts completed and in-progress tasks and shows each active item's `activeForm` label in place of its `subject`. Use this shape when your application maintains a progress display instead of logging each event.

The assigned task ID isn't in the `TaskCreate` input. Claude Code delivers each tool's structured output on the user message that carries its `tool_result` block, in the `tool_use_result` field. For `TaskCreate`, that object is documented for TypeScript as `TaskCreateOutput` under [Tool Output Types](/docs/en/agent-sdk/typescript#tool-output-types), and in Python the field is a plain dict of the same shape. The tracker pairs each `tool_result` block with its `tool_use` call by `tool_use_id` and reads `task.id` from the paired message's `tool_use_result`. Claude can read the list back with `TaskList` and one task's full details with `TaskGet`.

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  type Task = { subject: string; activeForm?: string; status: string };

  class TaskTracker {
    private tasks = new Map<string, Task>();
    private pendingCreates = new Map<string, { subject: string; activeForm?: string }>();

    displayProgress() {
      if (this.tasks.size === 0) {
        console.log("\nProgress: no open tasks\n");
        return;
      }

      const items = [...this.tasks.values()];
      const completed = items.filter((t) => t.status === "completed").length;
      const inProgress = items.filter((t) => t.status === "in_progress").length;

      console.log(`\nProgress: ${completed}/${this.tasks.size} completed`);
      console.log(`Currently working on: ${inProgress} task(s)\n`);

      for (const [id, task] of this.tasks) {
        const icon =
          task.status === "completed" ? "✅" : task.status === "in_progress" ? "🔧" : "❌";
        const text = task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
        console.log(`${id}. ${icon} ${text}`);
      }
    }

    handleToolUse(block: { id: string; name: string; input: unknown }) {
      if (block.name === "TaskCreate") {
        const input = block.input as { subject: string; activeForm?: string; active_form?: string };
        this.pendingCreates.set(block.id, {
          subject: input.subject,
          activeForm: input.activeForm ?? input.active_form,
        });
      } else if (block.name === "TaskUpdate") {
        const input = block.input as {
          taskId?: string;
          id?: string;
          task_id?: string;
          status?: string;
          activeForm?: string;
          active_form?: string;
        };
        const taskId = input.taskId ?? input.id ?? input.task_id;
        if (!taskId) return;
        if (input.status === "deleted") {
          this.tasks.delete(taskId);
          this.displayProgress();
          return;
        }
        const task = this.tasks.get(taskId);
        if (!task) return;
        if (input.status) task.status = input.status;
        const active = input.activeForm ?? input.active_form;
        if (active) task.activeForm = active;
        this.displayProgress();
      }
    }

    handleToolResult(block: { tool_use_id: string; is_error?: boolean }, result: unknown) {
      const create = this.pendingCreates.get(block.tool_use_id);
      if (!create) return;
      this.pendingCreates.delete(block.tool_use_id);
      if (block.is_error) return;
      // The result's user message carries the tool's structured output as
      // tool_use_result; for TaskCreate that's TaskCreateOutput,
      // { task: { id, subject } }.
      const out = result as { task?: { id: string } };
      if (!out?.task?.id) return;
      this.tasks.set(out.task.id, { ...create, status: "pending" });
      this.displayProgress();
    }

    async trackQuery(prompt: string) {
      try {
        for await (const message of query({
          prompt,
          options: { maxTurns: 20, permissionMode: "acceptEdits", env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } },
        })) {
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "tool_use") this.handleToolUse(block);
            }
          }
          if (message.type === "user" && Array.isArray(message.message.content)) {
            for (const block of message.message.content) {
              if (block.type === "tool_result") this.handleToolResult(block, message.tool_use_result);
            }
          }
        }
      } catch (error) {
        // A single-shot query() throws after yielding an error result,
        // such as when the maxTurns limit is hit.
        console.log(`Session ended with an error: ${error}`);
      }
    }
  }

  // Usage
  const tracker = new TaskTracker();
  await tracker.trackQuery("Build a complete authentication system with todos");
  ```

  ```python Python theme={null}
  import asyncio

  from claude_agent_sdk import (
      query,
      ClaudeAgentOptions,
      AssistantMessage,
      UserMessage,
      ToolUseBlock,
      ToolResultBlock,
  )


  class TaskTracker:
      def __init__(self):
          self.tasks: dict[str, dict] = {}
          self.pending_creates: dict[str, dict] = {}

      def display_progress(self):
          if not self.tasks:
              print("\nProgress: no open tasks\n")
              return

          completed = len([t for t in self.tasks.values() if t["status"] == "completed"])
          in_progress = len([t for t in self.tasks.values() if t["status"] == "in_progress"])

          print(f"\nProgress: {completed}/{len(self.tasks)} completed")
          print(f"Currently working on: {in_progress} task(s)\n")

          for task_id, task in self.tasks.items():
              icon = (
                  "✅"
                  if task["status"] == "completed"
                  else "🔧"
                  if task["status"] == "in_progress"
                  else "❌"
              )
              text = (
                  task["activeForm"]
                  if task["status"] == "in_progress" and task.get("activeForm")
                  else task["subject"]
              )
              print(f"{task_id}. {icon} {text}")

      def handle_tool_use(self, block: ToolUseBlock):
          if block.name == "TaskCreate":
              self.pending_creates[block.id] = {
                  "subject": block.input.get("subject", ""),
                  "activeForm": block.input.get("activeForm") or block.input.get("active_form"),
              }
          elif block.name == "TaskUpdate":
              task_id = (
                  block.input.get("taskId")
                  or block.input.get("id")
                  or block.input.get("task_id")
              )
              if not task_id:
                  return
              if block.input.get("status") == "deleted":
                  self.tasks.pop(task_id, None)
                  self.display_progress()
                  return
              task = self.tasks.get(task_id)
              if not task:
                  return
              if block.input.get("status"):
                  task["status"] = block.input["status"]
              active = block.input.get("activeForm") or block.input.get("active_form")
              if active:
                  task["activeForm"] = active
              self.display_progress()

      def handle_tool_result(self, block: ToolResultBlock, tool_use_result):
          create = self.pending_creates.pop(block.tool_use_id, None)
          if create is None or block.is_error:
              return
          # The result's user message carries the tool's structured output as
          # tool_use_result; for TaskCreate that's {"task": {"id": ..., "subject": ...}}.
          task = (tool_use_result or {}).get("task") or {}
          if not task.get("id"):
              return
          self.tasks[task["id"]] = {**create, "status": "pending"}
          self.display_progress()

      async def track_query(self, prompt: str):
          try:
              async for message in query(
                  prompt=prompt,
                  options=ClaudeAgentOptions(
                      max_turns=20,
                      permission_mode="acceptEdits",
                      env={"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"},
                  ),
              ):
                  if isinstance(message, AssistantMessage):
                      for block in message.content:
                          if isinstance(block, ToolUseBlock):
                              self.handle_tool_use(block)
                  if isinstance(message, UserMessage) and isinstance(message.content, list):
                      for block in message.content:
                          if isinstance(block, ToolResultBlock):
                              self.handle_tool_result(block, message.tool_use_result)
          except Exception as error:
              # A single-shot query() raises after yielding an error result,
              # such as when the max_turns limit is hit.
              print(f"Session ended with an error: {error}")


  # Usage
  async def main():
      tracker = TaskTracker()
      await tracker.track_query("Build a complete authentication system with todos")


  asyncio.run(main())
  ```
</CodeGroup>

## Related documentation

* [Agent SDK reference - TypeScript](/docs/en/agent-sdk/typescript): the options, types, and tool schemas for the TypeScript SDK, including the Task tool input and output types
* [Agent SDK reference - Python](/docs/en/agent-sdk/python): the options, types, and tool documentation for the Python SDK
* [Streaming Input](/docs/en/agent-sdk/streaming-vs-single-mode): the two input modes, and when to use streaming input instead of the single-shot calls these examples use
* [Give Claude custom tools](/docs/en/agent-sdk/custom-tools): define your own tools with the SDK's in-process MCP server
