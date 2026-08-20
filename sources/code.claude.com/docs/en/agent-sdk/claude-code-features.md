> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Use Claude Code features in the SDK

> Load project instructions, skills, hooks, and other Claude Code features into your SDK agents.

The Agent SDK is built on the same foundation as Claude Code, which means your SDK agents have access to the same filesystem-based features: project instructions (`CLAUDE.md` and rules), skills, hooks, and more.

When you omit `settingSources`, `query()` reads the same filesystem settings as the Claude Code CLI: user, project, and local settings, CLAUDE.md files, and `.claude/` skills, agents, and commands. To run without these, pass `settingSources: []`, which limits the agent to what you configure programmatically. Managed policy settings and the global `~/.claude.json` config are read regardless of this option. See [What settingSources does not control](#what-settingsources-does-not-control).

For a conceptual overview of what each feature does and when to use it, see [Extend Claude Code](/docs/en/features-overview).

## Control filesystem settings with settingSources

The setting sources option ([`setting_sources`](/docs/en/agent-sdk/python#claudeagentoptions) in Python, [`settingSources`](/docs/en/agent-sdk/typescript#settingsource) in TypeScript) controls which filesystem-based settings the SDK loads. Pass an explicit list to opt in to specific sources, or pass an empty array to disable user, project, and local settings.

This example loads both user-level and project-level settings by setting `settingSources` to `["user", "project"]`:

<CodeGroup>
  ```python Python theme={null}
  from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, ResultMessage
  import asyncio


  async def main():
      async for message in query(
          prompt="Help me refactor the auth module",
          options=ClaudeAgentOptions(
              # "user" loads from ~/.claude/, "project" loads from ./.claude/ in cwd.
              # Together they give the agent access to CLAUDE.md, skills, hooks, and
              # permissions from both locations.
              setting_sources=["user", "project"],
              allowed_tools=["Read", "Edit", "Bash"],
          ),
      ):
          if isinstance(message, AssistantMessage):
              for block in message.content:
                  if hasattr(block, "text"):
                      print(block.text)
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(f"\nResult: {message.result}")


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Help me refactor the auth module",
    options: {
      // "user" loads from ~/.claude/, "project" loads from ./.claude/ in cwd.
      // Together they give the agent access to CLAUDE.md, skills, hooks, and
      // permissions from both locations.
      settingSources: ["user", "project"],
      allowedTools: ["Read", "Edit", "Bash"]
    }
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") console.log(block.text);
      }
    }
    if (message.type === "result" && message.subtype === "success") {
      console.log(`\nResult: ${message.result}`);
    }
  }
  ```
</CodeGroup>

When this runs, the assistant's response prints to stdout, followed by a final result line once the run completes.

Each source loads settings from a specific location, where `<cwd>` is the working directory you pass via the `cwd` option, or the process's current directory if unset. For the full type definition, see [`SettingSource`](/docs/en/agent-sdk/typescript#settingsource) (TypeScript) or [`SettingSource`](/docs/en/agent-sdk/python#settingsource) (Python).

| Source      | What it loads                                                                                   | Location                                                                                                                                                                            |
| :---------- | :---------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"project"` | Project CLAUDE.md, `.claude/rules/*.md`, project skills, project hooks, project `settings.json` | `<cwd>/.claude/` for `settings.json` and hooks; `<cwd>` and every parent directory for CLAUDE.md and rules; `<cwd>` and every parent directory up to the repository root for skills |
| `"user"`    | User CLAUDE.md, `~/.claude/rules/*.md`, user skills, user settings                              | `~/.claude/`                                                                                                                                                                        |
| `"local"`   | CLAUDE.local.md, `.claude/settings.local.json`                                                  | `<cwd>/.claude/` for `settings.local.json`; `<cwd>` and every parent directory for CLAUDE.local.md                                                                                  |

Omitting `settingSources` is equivalent to `["user", "project", "local"]`.

The `cwd` option determines where the SDK looks for project-level inputs. Project `settings.json` and hooks load only from `<cwd>/.claude/` with no parent-directory fallback.

### What settingSources does not control

`settingSources` covers user, project, and local settings. A few inputs are read regardless of its value:

| Input                                                              | Behavior                                                                                                                                                                                                                                                                                                                                                             | To disable                                                                                                                                                                         |
| :----------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed policy settings                                            | Endpoint-managed policy, such as an MDM plist, registry policy, or managed settings file, loads from the host. [Server-managed settings](/docs/en/server-managed-settings) are fetched on an [eligible configuration](/docs/en/server-managed-settings#platform-availability) when the session authenticates with an organization OAuth login or a directly configured API key | Endpoint policy: remove the managed settings file, plist, or registry policy from the host. Server-managed settings: controlled by your org admin; cannot be disabled from the SDK |
| `~/.claude.json` global config                                     | Always read                                                                                                                                                                                                                                                                                                                                                          | Relocate with `CLAUDE_CONFIG_DIR` in `env`                                                                                                                                         |
| Auto memory at `~/.claude/projects/<project>/memory/`              | Loaded into the system prompt at session start. The agent writes new memories there with the standard `Write` and `Edit` tools rather than a dedicated memory tool, so those tools must be enabled for the agent to save memories                                                                                                                                    | Set `autoMemoryEnabled: false` in settings, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`                                                                                        |
| [claude.ai MCP connectors](/docs/en/mcp#use-mcp-servers-from-claude-ai) | Loaded when the session authenticates with your claude.ai login. Not loaded when `CLAUDE_CODE_OAUTH_TOKEN` holds a token from [`claude setup-token`](/docs/en/authentication#generate-a-long-lived-token), which can only make model requests. Passing `mcpServers: {}` does not suppress the connectors                                                                  | Set `strictMcpConfig: true`, [`disableClaudeAiConnectors: true`](/docs/en/mcp#disable-claude-ai-connectors) in settings, or `ENABLE_CLAUDEAI_MCP_SERVERS=false` in `env`                |

<Warning>
  Do not rely on default `query()` options for multi-tenant isolation. Because the inputs above are read regardless of `settingSources`, an SDK process can pick up host-level configuration and per-directory memory. For multi-tenant deployments, run each tenant in its own filesystem and set `settingSources: []` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`. [Server-managed settings](/docs/en/server-managed-settings) are fetched when the process authenticates with an organization credential; filesystem isolation does not remove them. See [Secure deployment](/docs/en/agent-sdk/secure-deployment).
</Warning>

## Project instructions (CLAUDE.md and rules)

`CLAUDE.md` files and `.claude/rules/*.md` files give your agent persistent context about your project: coding conventions, build commands, architecture decisions, and instructions. When `settingSources` includes `"project"` (as in the example above), the SDK loads these files into context at session start. The agent then follows your project conventions without you repeating them in every prompt.

### CLAUDE.md load locations

| Level                 | Location                                                                      | When loaded                                                                                         |
| :-------------------- | :---------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| Project (root)        | `<cwd>/CLAUDE.md` or `<cwd>/.claude/CLAUDE.md`                                | `settingSources` includes `"project"`                                                               |
| Project rules         | `<cwd>/.claude/rules/*.md` and `.claude/rules/*.md` in every parent directory | `settingSources` includes `"project"`                                                               |
| Project (parent dirs) | `CLAUDE.md` files in directories above `cwd`                                  | `settingSources` includes `"project"`, loaded at session start                                      |
| Project (child dirs)  | `CLAUDE.md` files in subdirectories of `cwd`                                  | `settingSources` includes `"project"`, loaded on demand when the agent reads a file in that subtree |
| Local                 | `<cwd>/CLAUDE.local.md` and `CLAUDE.local.md` in every parent directory       | `settingSources` includes `"local"`                                                                 |
| User                  | `~/.claude/CLAUDE.md`                                                         | `settingSources` includes `"user"`                                                                  |
| User rules            | `~/.claude/rules/*.md`                                                        | `settingSources` includes `"user"`                                                                  |

All levels are additive: if both project and user CLAUDE.md files exist, the agent sees both. There is no hard precedence rule between levels; if instructions conflict, the outcome depends on how Claude interprets them. Write non-conflicting rules, or state precedence explicitly in the more specific file ("These project instructions override any conflicting user-level defaults").

<Tip>
  You can also inject context directly via `systemPrompt` without using CLAUDE.md files. See [Modify system prompts](/docs/en/agent-sdk/modifying-system-prompts). Use CLAUDE.md when you want the same context shared between interactive Claude Code sessions and your SDK agents.
</Tip>

For how to structure and organize CLAUDE.md content, see [Manage Claude's memory](/docs/en/memory).

## Skills

Skills are markdown files that give your agent specialized knowledge and invocable workflows. Unlike `CLAUDE.md` (which loads every session), skills load on demand. The agent receives skill descriptions at startup and loads the full content when relevant.

Skills are discovered from the filesystem through `settingSources`. When the `skills` option on `query()` is omitted, discovered user and project skills are enabled and the Skill tool is available, matching CLI behavior. To control which skills are enabled, pass `skills` as `"all"`, a list of skill names, or `[]` to disable all. When `skills` is set, the SDK adds the Skill tool to `allowedTools` automatically. If you also pass an explicit `tools` list, include `"Skill"` in that list so Claude can invoke skills.

<CodeGroup>
  ```python Python theme={null}
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage
  import asyncio


  # Skills in .claude/skills/ are discovered automatically
  # when settingSources includes "project"
  async def main():
      async for message in query(
          prompt="Review this PR using our code review checklist",
          options=ClaudeAgentOptions(
              setting_sources=["user", "project"],
              skills="all",
              allowed_tools=["Read", "Grep", "Glob"],
          ),
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Skills in .claude/skills/ are discovered automatically
  // when settingSources includes "project"
  for await (const message of query({
    prompt: "Review this PR using our code review checklist",
    options: {
      settingSources: ["user", "project"],
      skills: "all",
      allowedTools: ["Read", "Grep", "Glob"]
    }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```
</CodeGroup>

<Note>
  Skills must be created as filesystem artifacts (`.claude/skills/<name>/SKILL.md`). The SDK does not have a programmatic API for registering skills. See [Agent Skills in the SDK](/docs/en/agent-sdk/skills) for full details.
</Note>

## Hooks

The SDK supports two ways to define hooks, and they run side by side:

* **Filesystem hooks:** shell commands defined in `settings.json`, loaded when `settingSources` includes the relevant source. These are the same hooks you'd configure for [interactive Claude Code sessions](/docs/en/hooks-guide).
* **Programmatic hooks:** callback functions passed directly to `query()`. These run in your application process and can return structured decisions. See [Control execution with hooks](/docs/en/agent-sdk/hooks).

Both types execute during the same hook lifecycle. If you already have hooks in your project's `.claude/settings.json` and you set `settingSources: ["project"]`, those hooks run automatically in the SDK with no extra configuration.

Hook callbacks receive the tool input and return a decision dict. Returning `{}` means allow the tool to proceed. To block execution, return a `hookSpecificOutput` object with `permissionDecision: "deny"` and a `permissionDecisionReason`. The reason is sent to Claude as the tool result. See the [hooks guide](/docs/en/agent-sdk/hooks) for the full callback signature and return types.

<CodeGroup>
  ```python Python theme={null}
  from claude_agent_sdk import query, ClaudeAgentOptions, HookMatcher, ResultMessage
  import asyncio


  # PreToolUse hook callback. Positional args:
  #   input_data: HookInput dict with tool_name, tool_input, hook_event_name
  #   tool_use_id: str | None, the ID of the tool call being intercepted
  #   context: HookContext, reserved for future abort-signal support
  async def audit_bash(input_data, tool_use_id, context):
      command = input_data.get("tool_input", {}).get("command", "")
      if "rm -rf" in command:
          return {
              "hookSpecificOutput": {
                  "hookEventName": "PreToolUse",
                  "permissionDecision": "deny",
                  "permissionDecisionReason": "Destructive command blocked",
              }
          }
      return {}  # Empty dict: allow the tool to proceed


  # Filesystem hooks from .claude/settings.json run automatically
  # when settingSources loads them. You can also add programmatic hooks:
  async def main():
      async for message in query(
          prompt="Refactor the auth module",
          options=ClaudeAgentOptions(
              setting_sources=["project"],  # Loads hooks from .claude/settings.json
              hooks={
                  "PreToolUse": [
                      HookMatcher(matcher="Bash", hooks=[audit_bash]),
                  ]
              },
          ),
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query, type HookInput, type HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

  // PreToolUse hook callback. HookInput is a discriminated union on
  // hook_event_name, so narrowing on it gives TypeScript the right
  // tool_input shape for this event.
  const auditBash = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input as { command?: string };
    if (toolInput.command?.includes("rm -rf")) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Destructive command blocked",
        },
      };
    }
    return {}; // Empty object: allow the tool to proceed
  };

  // Filesystem hooks from .claude/settings.json run automatically
  // when settingSources loads them. You can also add programmatic hooks:
  for await (const message of query({
    prompt: "Refactor the auth module",
    options: {
      settingSources: ["project"], // Loads hooks from .claude/settings.json
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [auditBash] }]
      }
    }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```
</CodeGroup>

### When to use which hook type

| Hook type                                 | Best for                                                                                                                                                                                                                                                                                                     |
| :---------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filesystem** (`settings.json`)          | Sharing hooks between CLI and SDK sessions. Supports `"command"` (shell scripts), `"http"` (POST to an endpoint), `"mcp_tool"` (call a connected MCP server's tool), `"prompt"` (LLM evaluates a prompt), and `"agent"` (spawns a verifier agent). These fire in the main agent and any subagents it spawns. |
| **Programmatic** (callbacks in `query()`) | Application-specific logic, structured decisions, and in-process integration. These also fire inside subagents. The hook input, the callback's first argument, carries `agent_id` and `agent_type` fields that identify which agent fired the hook.                                                          |

<Note>
  The TypeScript SDK supports additional hook events beyond Python, including `SessionStart`, `SessionEnd`, `TeammateIdle`, and `TaskCompleted`. See the [hooks guide](/docs/en/agent-sdk/hooks) for the full event compatibility table.
</Note>

For full details on programmatic hooks, see [Control execution with hooks](/docs/en/agent-sdk/hooks). For filesystem hook syntax, see [Hooks](/docs/en/hooks).

## Choose the right feature

The Agent SDK gives you access to several ways to extend your agent's behavior. If you're unsure which to use, this table maps common goals to the right approach.

| You want to...                                                                                    | Use                                           | SDK surface                                                                                                                                                    |
| :------------------------------------------------------------------------------------------------ | :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set project conventions your agent always follows                                                 | [CLAUDE.md](/docs/en/memory)                       | `settingSources: ["project"]` loads it automatically                                                                                                           |
| Give the agent reference material it loads when relevant                                          | [Skills](/docs/en/agent-sdk/skills)                | `settingSources` + `skills` option                                                                                                                             |
| Run a reusable workflow (deploy, review, release)                                                 | [User-invocable skills](/docs/en/agent-sdk/skills) | `settingSources` + `skills` option                                                                                                                             |
| Delegate an isolated subtask to a fresh context (research, review)                                | [Subagents](/docs/en/agent-sdk/subagents)          | `agents` parameter + `allowedTools: ["Agent"]`                                                                                                                 |
| Coordinate multiple Claude Code instances with shared task lists and direct inter-agent messaging | [Agent teams](/docs/en/agent-teams)                | Not directly configured via SDK options. Agent teams are a CLI feature where one session acts as the team lead, coordinating work across independent teammates |
| Run deterministic logic on tool calls (audit, block, transform)                                   | [Hooks](/docs/en/agent-sdk/hooks)                  | `hooks` parameter with callbacks, or shell scripts loaded via `settingSources`                                                                                 |
| Give Claude structured tool access to an external service                                         | [MCP](/docs/en/agent-sdk/mcp)                      | `mcpServers` parameter                                                                                                                                         |

<Tip>
  **Subagents versus agent teams:** Subagents are ephemeral and isolated: fresh conversation, one task, summary returned to parent. Agent teams coordinate multiple independent Claude Code instances that share a task list and message each other directly. Agent teams are a CLI feature. See [What subagents inherit](/docs/en/agent-sdk/subagents#what-subagents-inherit) and the [agent teams comparison](/docs/en/agent-teams#compare-with-subagents) for details.
</Tip>

Every feature you enable adds to your agent's context window. For per-feature costs and how these features layer together, see [Extend Claude Code](/docs/en/features-overview#understand-context-costs).

## Related resources

* [Extend Claude Code](/docs/en/features-overview): Conceptual overview of all extension features, with comparison tables and context cost analysis
* [Skills in the SDK](/docs/en/agent-sdk/skills): Full guide to using skills programmatically
* [Subagents](/docs/en/agent-sdk/subagents): Define and invoke subagents for isolated subtasks
* [Hooks](/docs/en/agent-sdk/hooks): Intercept and control agent behavior at key execution points
* [Permissions](/docs/en/agent-sdk/permissions): Control tool access with modes, rules, and callbacks
* [System prompts](/docs/en/agent-sdk/modifying-system-prompts): Inject context without CLAUDE.md files
