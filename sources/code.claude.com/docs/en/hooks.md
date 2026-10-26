> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Hooks reference

> Reference for Claude Code hook events, configuration schema, JSON input/output formats, exit codes, async hooks, HTTP hooks, prompt hooks, and MCP tool hooks.

> [!TIP]
>
> For a quickstart guide with examples, see [Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide.md).

Hooks are user-defined shell commands, HTTP endpoints, MCP tool calls, LLM prompts, or subagents that execute automatically at specific points in Claude Code's lifecycle. Claude Code fires the same hook events wherever it runs: sessions in the terminal, IDE extensions, the [Desktop app](https://code.claude.com/docs/en/desktop-quickstart.md), and [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md). Use this reference to look up event schemas, configuration options, JSON input/output formats, and advanced features like async hooks, HTTP hooks, and MCP tool hooks.

A plugin can also register hooks as JavaScript functions that Claude Code calls in its own process, which can draw in the interface as well as act on events. A plugin that does is a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md), and those function hooks are covered in [React to events](https://code.claude.com/docs/en/plugins/mods/events.md) rather than here. The hooks on this page keep working alongside mods.

## Hook lifecycle

Claude Code runs hooks at specific points during a session. When an event fires and a matcher matches, Claude Code passes JSON context about the event to your hook handler. For command hooks, input arrives on stdin. For HTTP hooks, it arrives as the POST request body. Your handler can then inspect the input, take action, and optionally return a decision.

Events fall into three cadences:

* per session: `SessionStart` and `SessionEnd`
* per turn: `UserPromptSubmit`, `Stop`, and `StopFailure`
* on every tool call inside the agentic loop: `PreToolUse` and `PostToolUse`, except [`EndConversation`](https://code.claude.com/docs/en/tools-reference#endconversation-tool-behavior) calls, which skip both

![Hook lifecycle diagram showing optional Setup feeding into SessionStart, then a per-turn loop containing UserPromptSubmit, UserPromptExpansion for slash commands, the nested agentic loop (PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, PostToolBatch, SubagentStart/Stop, TaskCreated, TaskCompleted), and Stop or StopFailure, followed by TeammateIdle, PreCompact, PostCompact, and SessionEnd, with Elicitation and ElicitationResult nested inside MCP tool execution, PermissionDenied as a side branch from PermissionRequest for auto-mode denials, WorktreeCreate, WorktreeRemove, Notification, ConfigChange, InstructionsLoaded, CwdChanged, FileChanged, and DirectoryAdded as standalone async events, PreModelSwitch as a standalone sequential event that runs before a requested model switch, PostModelSwitch as a standalone async event that runs after the session's model changes, and MessageDisplay as a display-only event that runs while assistant message text streams](https://mintcdn.com/claude-code/x7pO8l4XcvAXCoVc/images/hooks-lifecycle.svg?fit=max\&auto=format\&n=x7pO8l4XcvAXCoVc\&q=85\&s=81b9256c1bbe8832553485f5d9e9c746)

The table below summarizes when each event fires. The [Hook events](#hook-events) section documents the full input schema and decision control options for each one.

| Event | When it fires |
| :- | :- |
| `SessionStart` | When a session begins or resumes |
| `Setup` | When you start Claude Code with `--init-only`, or with `--init` or `--maintenance` in `-p` mode. For one-time preparation in CI or scripts |
| `UserPromptSubmit` | When a prompt is submitted, before Claude processes it. Also fires on [turns Claude Code starts on its own](https://code.claude.com/docs/en/hooks.md#userpromptsubmit) |
| `UserPromptExpansion` | When a user-typed command expands into a prompt, before it reaches Claude. Can block the expansion |
| `PreToolUse` | Before a tool call executes. Can block it |
| `PermissionRequest` | When a tool call needs a permission decision |
| `PermissionDenied` | When auto mode denies a tool call, including denials without a classifier verdict. Use JSON `hookSpecificOutput.retry: true` to tell the model it may retry the denied tool call. Claude Code ignores `retry` when the classifier produced no verdict |
| `PostToolUse` | After a tool call succeeds |
| `PostToolUseFailure` | After a tool call fails |
| `PostToolBatch` | After a full batch of parallel tool calls resolves, before the next model call |
| `Notification` | When Claude Code sends a notification |
| `MessageDisplay` | While assistant message text is displayed |
| `SubagentStart` | When a subagent is spawned |
| `SubagentStop` | When a subagent finishes |
| `TaskCreated` | When a task is being created via `TaskCreate` |
| `TaskCompleted` | When a task is being marked as completed |
| `Stop` | When Claude finishes responding |
| `StopFailure` | When the turn ends due to an API error |
| `TeammateIdle` | When an [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate is about to go idle |
| `InstructionsLoaded` | When a CLAUDE.md or `.claude/rules/*.md` file is loaded into context. Fires at session start and when files are lazily loaded during a session |
| `ConfigChange` | When a configuration file changes during a session |
| `CwdChanged` | When the working directory changes, for example when Claude executes a `cd` command. Useful for reactive environment management with tools like direnv |
| `DirectoryAdded` | When a working directory is added mid-session via `/add-dir` or the SDK `register_repo_root` control request |
| `FileChanged` | When a watched file changes on disk. The `matcher` field specifies which filenames to watch |
| `WorktreeCreate` | When a worktree is being created via `--worktree`, `isolation: "worktree"`, or for a background session. Replaces default git behavior |
| `WorktreeRemove` | When a worktree that a `WorktreeCreate` hook created is being removed |
| `PreCompact` | Before context compaction |
| `PostCompact` | After context compaction completes |
| `PreModelSwitch` | Before Claude Code applies a model switch that you or a client requested. Can block the switch |
| `PostModelSwitch` | After the session's model changes, including changes Claude Code makes on its own, such as restoring the model when you resume a session |
| `Elicitation` | When an MCP server requests user input during a tool call |
| `ElicitationResult` | After a user responds to an MCP elicitation, before the response is sent back to the server |
| `SessionEnd` | When a session terminates |

### How a hook resolves

To see how the event, the matcher, and the handler fit together, consider this `PreToolUse` hook that blocks destructive shell commands.

**macOS/Linux**

The `matcher` narrows to Bash tool calls and the `if` condition narrows further to Bash subcommands matching `rm *`, so `block-rm.sh` only spawns when both filters match:

```json theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh",
            "args": []
          }
        ]
      }
    ]
  }
}
```

The script reads the JSON input from stdin, extracts the command, and returns a `permissionDecision` of `"deny"` if it contains `rm -rf`. Save it to `.claude/hooks/block-rm.sh` in your project and make it executable with `chmod +x .claude/hooks/block-rm.sh` so Claude Code can run it:

```bash theme={null}
#!/bin/bash
# .claude/hooks/block-rm.sh
COMMAND=$(jq -r '.tool_input.command')

if echo "$COMMAND" | grep -q 'rm -rf'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Destructive command blocked by hook"
    }
  }'
else
  exit 0  # no decision; normal permission flow applies
fi
```

This script, like the other Bash examples on this page that parse JSON input, uses `jq`, so install `jq` and make sure it is on your `PATH` before trying them.

**Windows (PowerShell)**

The matcher `Bash|PowerShell` covers the [PowerShell tool](#powershell) as well as Bash. A single `if` rule matches only one tool's calls, so each tool gets its own handler: the first narrows to Bash subcommands matching `rm *`, the second to PowerShell commands matching `Remove-Item *`. Both run the same script through `powershell.exe`:

```json theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "powershell.exe",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.ps1"
            ]
          },
          {
            "type": "command",
            "if": "PowerShell(Remove-Item *)",
            "command": "powershell.exe",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.ps1"
            ]
          }
        ]
      }
    ]
  }
}
```

The `-NoProfile` flag skips loading your PowerShell profile so the hook starts fast, and `-ExecutionPolicy Bypass` lets PowerShell run the local script file.

The script reads the JSON input from stdin, extracts the command, and returns a `permissionDecision` of `"deny"` if it contains `rm -rf` or `Remove-Item` followed by `-Recurse`. Save it to `.claude/hooks/block-rm.ps1` in your project:

```powershell theme={null}
# .claude/hooks/block-rm.ps1
$callInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
$command = $callInput.tool_input.command

if ($command -match 'rm -rf|Remove-Item.*-Recurse') {
  @{
    hookSpecificOutput = @{
      hookEventName = "PreToolUse"
      permissionDecision = "deny"
      permissionDecisionReason = "Destructive command blocked by hook"
    }
  } | ConvertTo-Json
} else {
  exit 0  # no decision; normal permission flow applies
}
```

Now suppose Claude Code decides to run `Bash "rm -rf /tmp/build"` against the macOS/Linux config. Here's what happens:

![Diagram of hook resolution: PreToolUse fires, the matcher checks for a Bash match, then the if condition checks for a Bash(rm \*) match. If both match, the hook command runs and returns permissionDecision deny, so the tool call is blocked and Claude Code continues. If either check fails to match, the hook is skipped and the tool call is allowed to proceed.](https://mintcdn.com/claude-code/ikqp3_70mqIahteV/images/hook-resolution.svg?fit=max\&auto=format\&n=ikqp3_70mqIahteV\&q=85\&s=be0bf3053550c26de5f54cd64674c197)

**1. Event fires**

The `PreToolUse` event fires. Claude Code sends the tool input as JSON on stdin to the hook:

```json theme={null}
{ "tool_name": "Bash", "tool_input": { "command": "rm -rf /tmp/build" }, ... }
```

**2. Matcher checks**

The matcher `"Bash"` matches the tool name, so this hook group activates. If you omit the matcher or use `"*"`, the group activates on every occurrence of the event.

**3. If condition checks**

The `if` condition `"Bash(rm *)"` matches because `rm -rf /tmp/build` is a subcommand matching `rm *`, so this handler spawns. If the command had been `npm test`, the `if` check would fail and `block-rm.sh` would never run, avoiding the process spawn overhead. The `if` field is optional; without it, every handler in the matched group runs.

**4. Hook handler runs**

The script inspects the full command and finds `rm -rf`, so it prints a decision to stdout:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Destructive command blocked by hook"
  }
}
```

If the command had been a safer `rm` variant like `rm file.txt`, the script would hit `exit 0` instead. Exit code 0 with no output means the hook has no decision to report, so the tool call continues through the normal [permission flow](https://code.claude.com/docs/en/permissions.md). The hook can deny the call, but staying silent doesn't approve it.

**5. Claude Code acts on the result**

Claude Code reads the JSON decision, blocks the tool call, and shows Claude the reason.

The [Configuration](#configuration) section below documents the full schema, and each [hook event](#hook-events) section documents what input your command receives and what output it can return.

## Configuration

Hooks are defined in JSON settings files. The configuration has three levels of nesting:

1. Choose a [hook event](#hook-events) to respond to, like `PreToolUse` or `Stop`
2. Add a [matcher group](#matcher-patterns) to filter when it fires, like "only for the Bash tool"
3. Define one or more [hook handlers](#hook-handler-fields) to run when matched

See [How a hook resolves](#how-a-hook-resolves) above for a complete walkthrough with an annotated example.

> [!NOTE]
>
> This page uses specific terms for each level: **hook event** for the lifecycle point, **matcher group** for the filter, and **hook handler** for the shell command, HTTP endpoint, MCP tool, prompt, or agent that runs. "Hook" on its own refers to the general feature.

### Hook locations

Where you define a hook determines its scope:

| Location | Scope | Shareable |
| :- | :- | :- |
| `~/.claude/settings.json` | All your projects | No, local to your machine |
| `.claude/settings.json` | Single project | Yes, can be committed to the repo |
| `.claude/settings.local.json` | Single project | No, gitignored when Claude Code saves a setting to it |
| Managed policy settings | Organization-wide | Yes, admin-controlled |
| [Plugin](https://code.claude.com/docs/en/plugins/overview.md) `hooks/hooks.json` | When plugin is enabled | Yes, bundled with the plugin |
| [Skill](https://code.claude.com/docs/en/skills.md) frontmatter | The rest of the session once the skill is invoked. See [Hooks in skills and agents](#hooks-in-skills-and-agents) | Yes, defined in the skill file |
| [Subagent](https://code.claude.com/docs/en/sub-agents.md) frontmatter | While that subagent is running | Yes, defined in the subagent file |

[Cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md) don't read your local `~/.claude/settings.json`. In a [self-hosted environment](https://code.claude.com/docs/en/self-hosted-environments-configuration.md#permissions-and-tool-approval), Claude Code also runs the hooks the operator seeded from the runner host's `~/.claude/`, and it runs the hooks in the runner image's managed settings file when that file is among the [managed sources Claude Code applies](https://code.claude.com/docs/en/managed-settings.md#how-claude-code-combines-managed-sources), which by default means only when neither server-managed settings nor an MDM-delivered Claude Code policy supplies the managed tier. See [what carries over from your setup](https://code.claude.com/docs/en/cloud-environments.md#what-carries-over-from-your-setup) for which settings files and plugins, and so which hooks, reach a cloud session.

For details on settings file resolution, see [settings](https://code.claude.com/docs/en/settings.md).

Hooks from settings files, managed policy settings, and plugins also run inside [subagents](https://code.claude.com/docs/en/sub-agents.md). When a subagent calls a tool, tool events such as `PreToolUse` and `PostToolUse` fire the same configured hooks as in the main conversation, and the input carries the `agent_id` and `agent_type` [common input fields](#common-input-fields) that identify the subagent.

Administrators can use [`allowManagedHooksOnly`](https://code.claude.com/docs/en/settings-reference#allowmanagedhooksonly) in [managed settings](https://code.claude.com/docs/en/managed-settings.md) to restrict which hooks run:

* Your user, project, local, and plugin hooks are blocked. Hooks from plugins force-enabled in managed settings `enabledPlugins` are exempt
* Claude Code also narrows your [`statusLine`](https://code.claude.com/docs/en/statusline), [`fileSuggestion`](https://code.claude.com/docs/en/settings-reference#filesuggestion), and [`subagentStatusLine`](https://code.claude.com/docs/en/statusline#subagent-status-lines) settings to managed settings
* Claude Code also disables plugins with a [`command` source](https://code.claude.com/docs/en/plugins/marketplace-reference#command-plugin-source), including plugins force-enabled in managed settings `enabledPlugins`, unless [`disableCommandPluginSources`](https://code.claude.com/docs/en/settings-reference#disablecommandpluginsources) is explicitly set to `false`. `command` sources require Claude Code v2.1.229 or later
* Claude Code also blocks marketplace [`headersHelper` commands](https://code.claude.com/docs/en/plugins/host-marketplace#authenticate-archive-downloads) unless [`disableCommandPluginSources`](https://code.claude.com/docs/en/settings-reference#disablecommandpluginsources) is explicitly set to `false`, except for a marketplace that managed settings themselves declare

See [what runs under `allowManagedHooksOnly`](https://code.claude.com/docs/en/settings-reference#what-runs-under-allowmanagedhooksonly).

Hook entries merge across settings levels rather than replacing each other: user, project, and local settings add their own hooks without removing managed ones, and the [`disableAllHooks`](#disable-or-remove-hooks) setting can't disable managed hooks from outside managed settings.

The [HTTP hook allowlists](https://code.claude.com/docs/en/settings-reference.md#hook-and-skill-settings) apply to hooks from every source, including managed policy settings:

* `allowedHttpHookUrls`: when defined at any settings level, Claude Code runs an HTTP hook handler only if its URL matches the merged allowlist
* `httpHookAllowedEnvVars`: when defined, Claude Code interpolates only the environment variables on that list into hook headers

### Matcher patterns

The `matcher` field filters when hooks fire. How a matcher is evaluated depends on the characters it contains:

| Matcher value | Evaluated as | Example |
| :- | :- | :- |
| `"*"`, `""`, or omitted | Match all | fires on every occurrence of the event |
| Only letters, digits, `_`, `-`, spaces, `,`, and `\|` | Exact string, or list of exact strings separated by `\|` or `,` with optional surrounding whitespace | `Bash` matches only the Bash tool; `Edit\|Write` and `Edit, Write` each match either tool exactly; `code-reviewer` matches only that agent type |
| Contains any other character | JavaScript regular expression, unanchored | `^Notebook` matches any tool whose name starts with `Notebook`; `mcp__memory__.*` matches every tool from the `memory` server |

A matcher on the regular-expression path is tested with JavaScript's `RegExp.prototype.test`, which succeeds on a match anywhere in the value. `Edit.*` matches both `Edit` and `NotebookEdit`; wrap the pattern in `^` and `$`, as in `^Edit$`, when you need a whole-string match.

`FileChanged` and `StopFailure` use a narrower exact-match set of letters, digits, `_`, and `|` only. A hyphen, space, or comma in a matcher for those two events keeps it on the regular-expression path, and only `|` separates alternatives. Every other event with matcher support in the table that follows accepts `|` or `,`.

The `FileChanged` event doesn't follow these rules when building its watch list. See [FileChanged](#filechanged).

Each event type matches on a different field:

| Event | What the matcher filters | Example matcher values |
| :- | :- | :- |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | tool name | `Bash`, `Edit\|Write`, `mcp__.*` |
| `SessionStart` | how the session started | `startup`, `resume`, `clear`, `compact`, `fork` |
| `Setup` | which CLI flag triggered setup | `init`, `maintenance` |
| `SessionEnd` | why the session ended | `clear`, `resume`, `logout`, `prompt_input_exit`, `other` |
| `Notification` | notification type | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`, `plugin_notification` |
| `SubagentStart` | agent type | `general-purpose`, `Explore`, `Plan`, custom agent names, or plugin-scoped names like `^my-plugin:reviewer$` |
| `PreCompact`, `PostCompact` | what triggered compaction | `manual`, `auto` |
| `PreModelSwitch`, `PostModelSwitch` | canonical name of the model the session switches to, as described under [PreModelSwitch](#premodelswitch) | `claude-opus-5`, `claude-opus-4-6\|claude-opus-5`, `.*opus.*` |
| `SubagentStop` | agent type | same values as `SubagentStart` |
| `ConfigChange` | configuration source | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` |
| `CwdChanged` | no matcher support | always fires on every occurrence |
| `DirectoryAdded` | how the directory was added | `slash_command`, `register_repo_root` |
| `FileChanged` | literal filenames to watch (see [FileChanged](#filechanged)) | `.envrc\|.env` |
| `StopFailure` | error type | `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown` |
| `InstructionsLoaded` | load reason | `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact` |
| `UserPromptExpansion` | command name | your skill or command names |
| `Elicitation` | MCP server name | your configured MCP server names |
| `ElicitationResult` | MCP server name | same values as `Elicitation` |
| `UserPromptSubmit`, `PostToolBatch`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `MessageDisplay` | no matcher support | always fires on every occurrence |

Matching `StopFailure` on `cloud_credential_error` requires Claude Code v2.1.267 or later, the first version that reports credential-load failures under that value rather than `server_error` or `unknown`.

For most events, Claude Code evaluates the matcher against a field from the [JSON input](#hook-input-and-output) it sends to your hook on stdin. For tool events, that field is `tool_name`. For `PreModelSwitch` and `PostModelSwitch`, Claude Code evaluates the matcher against the canonical name it derives from `to_model`, as described under [PreModelSwitch](#premodelswitch). Each [hook event](#hook-events) section lists the full set of matcher values and the input schema for that event.

This example runs a linting script only when Claude writes or edits a file:

```json theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/lint-check.sh"
          }
        ]
      }
    ]
  }
}
```

If you add a `matcher` field to an event without matcher support, it is silently ignored.

For tool events, you can filter more narrowly by setting the [`if` field](#common-fields) on individual hook handlers. `if` uses [permission rule syntax](https://code.claude.com/docs/en/permissions.md) to match against the tool name and arguments together, so `"Bash(git *)"` runs when any subcommand of the Bash input matches `git *` and `"Edit(*.ts)"` runs only for TypeScript files.

#### Match MCP tools

[MCP](https://code.claude.com/docs/en/mcp.md) server tools appear as regular tools in tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`), so you can match them the same way you match any other tool name.

MCP tools follow the naming pattern `mcp__<server>__<tool>`, for example:

* `mcp__memory__create_entities`: Memory server's create entities tool
* `mcp__filesystem__read_file`: Filesystem server's read file tool
* `mcp__github__search_repositories`: GitHub server's search tool

To match every tool from a server, append `.*` to the server prefix. The `.*` is required: a matcher like `mcp__memory` or `mcp__brave-search` contains only exact-match characters, so it is compared as an exact string and matches no tool.

* `mcp__memory__.*` matches all tools from the `memory` server
* `mcp__brave-search__.*` matches all tools from a server whose name contains a hyphen
* `mcp__.*__write.*` matches any tool whose name starts with `write` from any server

Tools from a [plugin-bundled MCP server](https://code.claude.com/docs/en/mcp.md#plugin-provided-mcp-servers) use a scoped server segment that includes the plugin name: `mcp__plugin_<plugin-name>_<server-name>__<tool>`. A matcher written against the bare server key never fires for these tools. For a plugin named `my-plugin` that bundles a server under the key `db`, a `query` tool appears as `mcp__plugin_my-plugin_db__query`, so the matcher for every tool from that server is `mcp__plugin_my-plugin_db__.*`. Use the same scoped tool name in a handler's [`if` field](#common-fields). See [Plugin-provided MCP servers](https://code.claude.com/docs/en/mcp.md#plugin-provided-mcp-servers) for how the scoped name is built.

This example logs all memory server operations and validates write operations from any MCP server:

```json theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__memory__.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Memory operation initiated' >> ~/mcp-operations.log"
          }
        ]
      },
      {
        "matcher": "mcp__.*__write.*",
        "hooks": [
          {
            "type": "command",
            "command": "/home/user/scripts/validate-mcp-write.py"
          }
        ]
      }
    ]
  }
}
```

### Hook handler fields

Each object in the inner `hooks` array is a hook handler: the shell command, HTTP endpoint, MCP tool, LLM prompt, or agent that runs when the matcher matches. There are five types:

* **[Command hooks](#command-hook-fields)** (`type: "command"`): run a shell command. Your script receives the event's [JSON input](#hook-input-and-output) on stdin and communicates results back through exit codes and stdout.
* **[HTTP hooks](#http-hook-fields)** (`type: "http"`): send the event's JSON input as an HTTP POST request to a URL. The endpoint communicates results back through the response body using the same [JSON output format](#json-output) as command hooks.
* **[MCP tool hooks](#mcp-tool-hook-fields)** (`type: "mcp_tool"`): call a tool on a configured [MCP server](https://code.claude.com/docs/en/mcp.md). The tool's text output is treated like command-hook stdout.
* **[Prompt hooks](#prompt-and-agent-hook-fields)** (`type: "prompt"`): send a prompt to a Claude model for single-turn evaluation. The model returns its decision as JSON. See [Prompt-based hooks](#prompt-based-hooks).
* **[Agent hooks](#prompt-and-agent-hook-fields)** (`type: "agent"`): spawn a subagent that can use tools like Read, Grep, and Glob to verify conditions before returning a decision. Agent hooks are experimental and may change. See [Agent-based hooks](#agent-based-hooks).

When an event fires, its matching hooks run in parallel. If more than 12 of them are prompt or agent hooks, 12 of those run at once and the rest start as running ones finish. Each waiting hook's [`timeout`](#common-fields) starts counting when that hook starts.

If you define the same handler in more than one settings file, it runs once. A plugin's or skill's copy of the same handler stays separate.

Handlers run in the current directory with Claude Code's environment. If the current directory no longer exists, for example a worktree or temp directory that another shell deleted mid-session, Claude Code runs command hooks from the first of these that still exists: the directory the session started in, the project root, your home directory, or the system temp directory. Claude Code records a warning naming the fallback directory in the [debug log](#debug-hooks). For a worktree session that you start from the desktop app, see [What worktrees share with the main checkout](https://code.claude.com/docs/en/worktrees.md#what-worktrees-share-with-the-main-checkout).

The `$CLAUDE_CODE_REMOTE` environment variable is `"true"` in remote web environments and not set in the local CLI. Claude Code v2.1.199 and later sets [`$CLAUDE_CODE_BRIDGE_SESSION_ID`](https://code.claude.com/docs/en/env-vars) to the [Remote Control](https://code.claude.com/docs/en/remote-control.md) session ID while the local session has an active Remote Control connection.

#### Common fields

These fields apply to all hook types:

| Field | Required | Description |
| :- | :- | :- |
| `type` | yes | `"command"`, `"http"`, `"mcp_tool"`, `"prompt"`, or `"agent"` |
| `if` | no | [Permission rule syntax](https://code.claude.com/docs/en/permissions.md#permission-rule-syntax) to filter when this hook runs, such as `"Bash(git *)"` or `"Edit(*.ts)"`. The hook command only runs if the tool call matches the pattern. See the [Bash matching table](#bash-if-matching) for how Bash patterns evaluate against subcommands, `$()`, and backticks. Only evaluated on tool events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, and `PermissionDenied`. On other events, a hook with `if` set never runs |
| `timeout` | no | Seconds before canceling. Claude Code doesn't enforce it on a command hook you run with [`async: true`](#run-hooks-in-the-background). Defaults: 600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`. Claude Code lowers the `command`, `http`, and `mcp_tool` default to 30 on [`UserPromptSubmit`](#userpromptsubmit), [`PreModelSwitch`](#premodelswitch), and [`PostModelSwitch`](#postmodelswitch), and to 10 on [`MessageDisplay`](#messagedisplay). [`SessionEnd`](#sessionend) hooks share a 1.5-second budget; if your settings set a longer per-hook `timeout`, Claude Code raises the budget to match, up to 60 seconds |
| `statusMessage` | no | Custom spinner message displayed while the hook runs |
| `once` | no | If `true`, Claude Code removes the hook after its first successful run. A run that fails, blocks with exit code 2, or times out leaves the hook in place, so it runs again on the next matching event. Only honored for hooks declared in [skill frontmatter](#hooks-in-skills-and-agents); ignored in settings files and agent frontmatter |

The `if` field holds exactly one permission rule. There is no `&&`, `||`, or list syntax for combining rules; to apply multiple conditions, define a separate hook handler for each.

In an `if` condition for a file tool, a single-segment directory pattern like `"Edit(src/**)"` matches only the `src` directory in the working directory and the files under it. To match a directory named `src` at any depth, write `"Edit(**/src/**)"`.

#### How `if` patterns match Bash commands

For Bash patterns in the [`if` field](#common-fields), whether your hook command runs depends on the shape of the pattern and the Bash command Claude is invoking. Leading `VAR=value` assignments are stripped before matching.

| `if` pattern | Bash command | Hook runs? | Why |
| :- | :- | :- | :- |
| `Bash(git *)` | `FOO=bar git push` | yes | leading assignments are stripped; `git push` matches |
| `Bash(git *)` | `npm test && git push` | yes | each subcommand is checked; `git push` matches |
| `Bash(rm *)` | `echo $(rm -rf /)` | yes | commands inside `$()` and backticks are checked; `rm -rf /` matches |
| `Bash(rm *)` | `echo $(date)` | no | no subcommand matches `rm *` |
| `Bash(git push *)` | `echo $(date)` | yes | patterns that specify more than the command name run the hook anyway on `$()`, backticks, or `$VAR` |

When Claude Code can't determine which commands the Bash input runs, it runs your hook regardless of the pattern. Because the `if` filter is best-effort, use the [permission system](https://code.claude.com/docs/en/permissions.md) rather than a hook to enforce a hard allow or deny.

#### Command hook fields

In addition to the [common fields](#common-fields), command hooks accept these fields:

| Field | Required | Description |
| :- | :- | :- |
| `command` | yes | Shell command to execute. With `args`, the executable to spawn directly. See [Exec form and shell form](#exec-form-and-shell-form) |
| `args` | no | Argument list. When present, `command` is resolved as an executable and spawned directly with `args` as the argument vector, with no shell involved. See [Exec form and shell form](#exec-form-and-shell-form) |
| `async` | no | If `true`, runs in the background without blocking. See [Run hooks in the background](#run-hooks-in-the-background) |
| `asyncRewake` | no | If `true`, runs in the background and wakes Claude on exit code 2. The hook's stderr, or stdout if stderr is empty, is shown to Claude as a [system reminder](https://code.claude.com/docs/en/glossary.md#system-reminder) so it can react to a long-running background failure |
| `shell` | no | Shell to use for this hook. Accepts `"bash"` or `"powershell"`. Defaults to `"bash"`, or to `"powershell"` on Windows when Git Bash isn't installed. Setting `"powershell"` runs the command via PowerShell on Windows. Does not require `CLAUDE_CODE_USE_POWERSHELL_TOOL` since hooks spawn PowerShell directly. Ignored when `args` is set |
| `onFailure` | no | Whether the action that triggered the hook goes ahead when the hook fails: `"continue"` or `"block"`. See [Block the action when a hook fails](#block-the-action-when-a-hook-fails) for `"block"` and for leaving the field unset. Requires Claude Code v2.1.295 or later |

##### Exec form and shell form

A command hook runs as exec form when `args` is set, and shell form when `args` is omitted. Set `args` whenever the hook references a [path placeholder](#reference-scripts-by-path), since each element is passed as one argument with no quoting. Omit `args` when you need shell features like pipes or `&&`, or when neither concern applies.

**Exec form** runs when `args` is present. Claude Code resolves `command` as an executable on `PATH` and spawns it directly with `args` as the argument vector. There is no shell, so each `args` element is one argument exactly as written, and path placeholders like `${CLAUDE_PLUGIN_ROOT}` are substituted into `command` and into each `args` element as plain strings. Special characters such as apostrophes, `$`, and backticks pass through verbatim because there is no shell to interpret them. No shell tokenization happens on any platform.

**Shell form** runs when `args` is absent. The `command` string is passed to a shell: `sh -c` on macOS and Linux, Git Bash on Windows, or PowerShell when Git Bash isn't installed. Set the `shell` field to choose explicitly. The shell tokenizes the string, expands variables, and interprets pipes, `&&`, redirects, and globs.

> [!NOTE]
>
> On Windows, exec form requires `command` to resolve to a real executable such as a `.exe`. The `.cmd` and `.bat` shims that npm, npx, eslint, and other tools install in `node_modules/.bin` are not executables and can't be spawned without a shell. To run them in exec form, invoke the underlying script with `node` directly, for example `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/node_modules/eslint/bin/eslint.js"]`. The `node` plus script-path pattern works on every platform because `node.exe` is a real binary. To run a `.cmd` or `.bat` shim by name, use shell form.

This example runs a Node script bundled with a plugin. Exec form passes the resolved script path as one argument with no quoting:

```json theme={null}
{
  "type": "command",
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/format.js", "--fix"]
}
```

The equivalent shell form needs quoting to handle paths with spaces or special characters:

```json theme={null}
{
  "type": "command",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}\"/scripts/format.js --fix"
}
```

Both forms support the same [path placeholders](#reference-scripts-by-path), and both export them as the environment variables `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, and `CLAUDE_PLUGIN_DATA` on the spawned process, so a script can read `process.env.CLAUDE_PLUGIN_ROOT` regardless of how it was launched.

Plugin hooks additionally substitute [`${user_config.*}`](https://code.claude.com/docs/en/plugins/manifest-reference#user-configuration) values, in exec form only: the value is substituted into `command` and into each `args` element as a plain string, so no shell re-parses it.

A shell-form plugin hook whose `command` references `${user_config.*}` fails with an [error](https://code.claude.com/docs/en/errors.md#plugin-command-references-user-config) instead of running. To use an option value from a shell-form hook, read the `$CLAUDE_PLUGIN_OPTION_<KEY>` environment variable, such as `$CLAUDE_PLUGIN_OPTION_WEBHOOK_URL` for a `webhook_url` option, or set `args` to switch the hook to exec form. Before v2.1.207, shell-form plugin hook commands also substituted `${user_config.*}`.

> [!NOTE]
>
> In exec form, `command` is the executable name or path only. If `command` is a bare name with no path separator and contains whitespace alongside `args`, Claude Code logs a warning because the spawn will fail: there is no executable named `node script.js`. Move the extra tokens into `args`. Absolute paths with spaces, such as `C:\Program Files\nodejs\node.exe`, are a single valid executable and don't trigger the warning.

#### HTTP hook fields

In addition to the [common fields](#common-fields), HTTP hooks accept these fields:

| Field | Required | Description |
| :- | :- | :- |
| `url` | yes | URL to send the POST request to |
| `headers` | no | Additional HTTP headers as key-value pairs. Values support environment variable interpolation using `$VAR_NAME` or `${VAR_NAME}` syntax. Only variables listed in `allowedEnvVars` are resolved |
| `allowedEnvVars` | no | List of environment variable names that may be interpolated into header values. References to unlisted variables are replaced with empty strings. Required for any env var interpolation to work |
| `onFailure` | no | What happens to the action when the hook fails: `"continue"`, the default, or `"block"`. See [Block the action when a hook fails](#block-the-action-when-a-hook-fails). Requires Claude Code v2.1.295 or later |

Claude Code sends the hook's [JSON input](#hook-input-and-output) as the POST request body with `Content-Type: application/json`. The response body uses the same [JSON output format](#json-output) as command hooks.

Error handling differs from command hooks; see [HTTP response handling](#http-response-handling).

This example sends `PreToolUse` events to a local validation service, authenticating with a token from the `MY_TOKEN` environment variable:

```json theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8080/hooks/pre-tool-use",
            "timeout": 30,
            "headers": {
              "Authorization": "Bearer $MY_TOKEN"
            },
            "allowedEnvVars": ["MY_TOKEN"]
          }
        ]
      }
    ]
  }
}
```

#### MCP tool hook fields

In addition to the [common fields](#common-fields), MCP tool hooks accept these fields:

| Field | Required | Description |
| :- | :- | :- |
| `server` | yes | Name of a configured MCP server. For a [plugin-bundled server](https://code.claude.com/docs/en/mcp.md#plugin-provided-mcp-servers), this is the scoped name `plugin:<plugin-name>:<server-name>`, such as `plugin:my-plugin:db`, not the bare server key |
| `tool` | yes | Name of the tool to call on that server |
| `input` | no | Arguments passed to the tool. String values support `${path}` substitution from the hook's [JSON input](#hook-input-and-output), such as `"${tool_input.file_path}"` |

This example calls the `security_scan` tool on the `my_server` MCP server after each `Write` or `Edit`, passing the edited file's path:

```json theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "my_server",
            "tool": "security_scan",
            "input": { "file_path": "${tool_input.file_path}" }
          }
        ]
      }
    ]
  }
}
```

##### How the tool's result is read

Claude Code reads the tool's text content the same way it reads command-hook stdout, following the [parsing rule under exit code 0](#exit-code-0). If the tool returns `isError: true`, the hook produces a non-blocking error and execution continues.

##### When the server is still connecting

On events where a hook can block or change the result, such as `PreToolUse` or `Stop`, Claude Code waits for a connecting server before it calls the tool, for at most [`MCP_TIMEOUT`](https://code.claude.com/docs/en/env-vars) and within the hook's own [`timeout`](#common-fields). On observational events, such as `Notification` or `SessionEnd`, it doesn't wait.

A server showing the [`cached` status](https://code.claude.com/docs/en/mcp#server-status-detail) connects when the hook calls its tool. If the server isn't connected at that point, the hook produces a non-blocking error and execution continues. The hook never starts an OAuth flow, so [authenticate the server from `/mcp`](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers) first.

##### Events that fire before MCP servers are available

`SessionStart` at launch, including with `--continue` or `--resume`, and every `Setup` event fire before the session's MCP servers are available to hooks. Claude Code skips their `mcp_tool` hooks without calling the tool, and the [debug log](#debug-hooks) records `mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)`, or the same message naming `Setup`. When `SessionStart` fires again later in the session, after `/clear` or a compaction, its `mcp_tool` hooks run. For anything the session needs at launch, use a `type: "command"` hook on `SessionStart` instead.

#### Prompt and agent hook fields

In addition to the [common fields](#common-fields), prompt and agent hooks accept these fields:

| Field | Required | Description |
| :- | :- | :- |
| `prompt` | yes | Prompt text to send to the model. Use `$ARGUMENTS` as a placeholder for the hook input JSON. Escape with a backslash to include literal text: `\$1.00` renders as `$1.00` |
| `model` | no | Model to use for evaluation. Defaults to the model Claude Code uses for [background functionality](https://code.claude.com/docs/en/costs.md#background-token-usage) |

### Reference scripts by path

Use these placeholders to reference hook scripts relative to the project or plugin root, regardless of the working directory when the hook runs:

* `${CLAUDE_PROJECT_DIR}`: the project root where the session started. Claude Code also sets this variable in the environment of [stdio MCP servers](https://code.claude.com/docs/en/mcp.md#option-3-add-a-local-stdio-server) and plugin LSP servers.
* `${CLAUDE_PLUGIN_ROOT}`: the plugin's installation directory, for scripts bundled with a [plugin](https://code.claude.com/docs/en/plugins/overview.md). See [plugin environment variables](https://code.claude.com/docs/en/plugins/manifest-reference.md#environment-variables) for how the path behaves across updates.
* `${CLAUDE_PLUGIN_DATA}`: the plugin's [persistent data directory](https://code.claude.com/docs/en/plugins/components.md#path-variables-and-persistent-data), for dependencies and state that should survive plugin updates.

> [!NOTE]
>
> **Worktrees are different.** If Claude enters a [worktree](https://code.claude.com/docs/en/worktrees.md) during the session, Claude Code keeps `${CLAUDE_PROJECT_DIR}` where it was and passes the worktree path to your hooks a different way:
>
> * **`${CLAUDE_PROJECT_DIR}` stays put**: it still points at the project root where the session started, so a command such as `${CLAUDE_PROJECT_DIR}/.claude/hooks/check-style.sh` still runs the script in the main checkout.
> * **`cwd` follows Claude**: the `cwd` field in the hook's [input JSON](#common-input-fields) is the worktree root after Claude enters a worktree, and the new directory after Claude runs `cd`. Read it when a hook needs to know which directory Claude is working in.
>
> For a worktree session that you start from the desktop app, see [What worktrees share with the main checkout](https://code.claude.com/docs/en/worktrees.md#what-worktrees-share-with-the-main-checkout) for where `${CLAUDE_PROJECT_DIR}` points.

Prefer [exec form](#exec-form-and-shell-form) for any hook that references a path placeholder. In shell form, wrap each placeholder in double quotes.

**Project scripts**

This example uses `${CLAUDE_PROJECT_DIR}` to run a style checker from the project's `.claude/hooks/` directory after any `Write` or `Edit` tool call:

```json theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/check-style.sh",
            "args": []
          }
        ]
      }
    ]
  }
}
```

**Plugin scripts**

Define plugin hooks in `hooks/hooks.json` with an optional top-level `description` field. When a plugin is enabled, its hooks merge with your user and project hooks.

This example runs a formatting script bundled with the plugin:

```json theme={null}
{
  "description": "Automatic code formatting",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh",
            "args": [],
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

See the [plugin components reference](https://code.claude.com/docs/en/plugins/components.md#hooks) for details on creating plugin hooks.

### Hooks in skills and agents

In addition to settings files and plugins, hooks can be defined directly in [skills](https://code.claude.com/docs/en/skills.md) and [subagents](https://code.claude.com/docs/en/sub-agents.md) using frontmatter, in the same configuration format as settings-based hooks. How long Claude Code keeps them registered depends on the component:

* **Subagent hooks**: Claude Code runs them only while that subagent is running and removes them when it finishes. Claude Code converts a `Stop` hook here to `SubagentStop`, the event it fires when a subagent completes.
* **Skill hooks**: Claude Code registers them when you or Claude invoke the skill and keeps running them for the rest of the session, on turns after the skill's own turn as well. To have Claude Code remove a hook after its first successful run instead, set [`once: true`](#common-fields) on it.

This skill defines a `PreToolUse` hook that runs a security validation script before each `Bash` command:

```yaml theme={null}
---
name: secure-operations
description: Perform operations with security checks
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/security-check.sh"
---
```

Subagents use the same format in their YAML frontmatter.

Frontmatter hooks in a project skill follow the same [workspace trust rule as hooks in settings files](#workspace-trust). Claude Code registers them when you or Claude invoke the skill, including in a `-p` run in a folder you haven't trusted.

Frontmatter hooks in a project subagent run only after you accept the [workspace trust dialog](https://code.claude.com/docs/en/permissions.md#project-allow-rules-and-workspace-trust) for the folder the agent file came from. A `-p` session doesn't count as accepting it. [What runs before you trust a folder](https://code.claude.com/docs/en/permissions.md#what-runs-before-you-trust-a-folder) compares this with the settings-file rule, and the subagents page lists [which scopes are exempt](https://code.claude.com/docs/en/sub-agents.md#hooks-in-subagent-frontmatter). Before v2.1.218, these hooks could run from folders you hadn't trusted.

#### Limits on skill hooks

When a skill's frontmatter hooks don't fire after you or Claude invoke the skill, run [`/hooks`](#the-%2Fhooks-menu) in that session. If it lists them, see [Hook not firing](https://code.claude.com/docs/en/hooks-guide.md#hook-not-firing). If it lists none of them, the skill may be under a plugin-only lock or past a hook limit, and runs without any of its frontmatter hooks. Check for each case:

* **Plugin-only lock**: your organization's administrator can lock hooks to plugins and managed settings with the [`strictPluginOnlyCustomization`](https://code.claude.com/docs/en/settings-reference#strictpluginonlycustomization-hooks) managed setting. A skill keeps its frontmatter hooks under that lock only if it's a plugin skill, a [bundled skill](https://code.claude.com/docs/en/skills.md#bundled-skills), or a skill in the [managed settings directory](https://code.claude.com/docs/en/managed-settings.md#delivery-mechanisms). The hooks in your own settings files don't run either.
  * **Check**: type `/status` in a Claude Code session. If the [`Setting sources` line](https://code.claude.com/docs/en/settings#check-what-your-organization-enforces) includes `Enterprise managed settings`, ask your administrator whether `strictPluginOnlyCustomization` locks hooks.
  * **Fix**: move the skill into a [plugin](https://code.claude.com/docs/en/plugins/create.md#convert-an-existing-claude-setup), because plugin skills keep their frontmatter hooks. List the plugin in a [marketplace](https://code.claude.com/docs/en/plugins/create-marketplace.md#create-a-marketplace), then install it from there. If Claude Code refuses the marketplace with [`is blocked by enterprise policy`](https://code.claude.com/docs/en/plugins/troubleshooting#marketplace-source-is-blocked-by-enterprise-policy), ask your administrator to allow that marketplace.
* **Hook limit**: in Claude Code v2.1.304 or later, each source of skills has its own limit per session. Your project, your personal skills folder, and each plugin count as separate sources. The skills from one source can register at most 1,024 hooks. Those hooks' matchers can total at most 16,384 characters. A matcher with several hooks under it counts once for each hook.
  * **Check**: repeat the session where the hook didn't fire, with debug logging on:
    1. Start a new session from your shell with `claude --debug`. If you don't start sessions from a shell, type [`/debug`](https://code.claude.com/docs/en/commands#all-commands) first in the new session instead.
    2. Invoke the same skills in the same order, including the ones Claude invoked, because both totals build up skill by skill. Ask Claude to invoke any skill you can't type as a command.
    3. Search the [debug log](#debug-hooks) for `registers none of its hooks`. A line containing that text names the skill that went past the limit.
  * **Fix**: declare fewer hooks or shorter matchers in that skill or in the other skills from its source, then start a new session. If those skills aren't yours to edit, ask their author for that change. Until then, start a new session and invoke the skill you need before any other skill from its source.

If neither case is yours, check for [frontmatter that didn't parse](https://code.claude.com/docs/en/skills.md#skill-not-triggering).

### The `/hooks` menu

Type `/hooks` in Claude Code to open a read-only browser for your configured hooks. The list labels each hook with where it comes from, such as user settings, project settings, local settings, a plugin, or the current session.

Select a hook to see the full text of what it runs and where it's defined, such as the path of its settings file or the name of its plugin.

To browse all hook events, including ones with no hooks configured, select `All events` at the end of the list.

### Disable or remove hooks

To remove a hook defined in a settings file, delete its entry from that file.

To temporarily disable all hooks without removing them, set `"disableAllHooks": true` in your settings file. Claude Code reads the value left after [settings precedence](https://code.claude.com/docs/en/settings.md#settings-precedence) applies, so a `"disableAllHooks": false` in a project's `.claude/settings.json` overrides a `true` in your user settings. To turn hooks off for one run whatever the project's settings say, pass `--settings '{"disableAllHooks": true}'`, which takes precedence over project and local settings. There is no way to disable an individual hook while keeping it in the configuration.

The `disableAllHooks` setting respects the managed settings hierarchy. If an administrator has configured hooks through managed policy settings, `disableAllHooks` set in user, project, or local settings can't disable those managed hooks. Only `disableAllHooks` set at the managed settings level can disable managed hooks. For the full reach of each level, see [`disableAllHooks`](https://code.claude.com/docs/en/settings-reference#disableallhooks).

Direct edits to hooks in settings files are normally picked up automatically by the file watcher.

## Hook input and output

Command hooks receive JSON data via stdin and communicate results through exit codes, stdout, and stderr. HTTP hooks receive the same JSON as the POST request body and communicate results through the HTTP response body. This section covers fields and behavior common to all events. Each event's section under [Hook events](#hook-events) includes its specific input schema and decision control options.

On macOS and Linux, command hooks run in their own session without a controlling terminal. The hook process and any child processes can't open `/dev/tty` or send escape sequences directly to the Claude Code interface. Windows has no `/dev/tty`.

To surface a message to the user on any platform, return [`systemMessage`](#json-output) in JSON output. Some events discard it or deliver it elsewhere, and each [event's section](#hook-events) says so. To trigger a desktop notification, set a window title, or ring the bell, return [`terminalSequence`](#emit-terminal-notifications) instead.

### Common input fields

Hook events receive these fields as JSON, in addition to event-specific fields documented in each [hook event](#hook-events) section. For command hooks, this JSON arrives via stdin. For HTTP hooks, it arrives as the POST request body.

| Field | Description |
| :- | :- |
| `session_id` | Current session identifier |
| `prompt_id` | UUID identifying the user prompt currently being processed. Matches the [`prompt.id` attribute on OpenTelemetry events](https://code.claude.com/docs/en/monitoring-usage#event-correlation-attributes), so you can correlate hook output with telemetry for a single prompt. Absent until the first user input |
| `transcript_path` | Path to conversation JSON. The transcript file is written asynchronously and may lag the in-memory conversation, so it may not yet include the current turn's most recent messages when a hook fires. Hooks that need the final assistant text of the current turn should use `last_assistant_message` on [Stop](#stop) and [SubagentStop](#subagentstop) instead of reading the transcript |
| `cwd` | Current working directory when the hook is invoked |
| `scratchpad_dir` | Path to the session's [scratchpad directory](https://code.claude.com/docs/en/claude-directory.md#session-scratchpad-directory), where Claude keeps temporary working files. Absent when the session has no scratchpad or the temp directory is unavailable. Requires Claude Code v2.1.257 or later |
| `permission_mode` | Current [permission mode](https://code.claude.com/docs/en/permissions.md#permission-modes): `"default"`, `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, or `"bypassPermissions"`. The mode labeled **Manual** arrives as `"default"`, never as `"manual"`, so scripts that match `"default"` keep working. Not all events receive this field. Check the JSON example in each [hook event](#hook-events) section |
| `effort` | Object with a `level` field holding the [effort level](https://code.claude.com/docs/en/model-config.md#adjust-effort-level) in effect when the hook runs: `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`. If you set a level the active model doesn't support, `level` reports the level Claude Code ran instead; [Adjust effort level](https://code.claude.com/docs/en/model-config.md#adjust-effort-level) says how it picks that level. The object matches the [status line](https://code.claude.com/docs/en/statusline.md#available-data) `effort` field. Present for events that fire within a tool-use context, such as `PreToolUse`, `PostToolUse`, `Stop`, and `SubagentStop`, when the current model supports the effort parameter. The level is also available to hook commands and the Bash tool as the `$CLAUDE_EFFORT` environment variable. |
| `hook_event_name` | Name of the event that fired |

`agent_id` and `agent_type` tell your script which agent a hook fired in, such as a subagent, an [in-process teammate](https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode), or the agent you chose with `--agent`:

| Field | Description |
| :- | :- |
| `agent_id` | Unique identifier for the subagent or in-process teammate the hook fires in. |
| `agent_type` | Agent name (for example, `"Explore"` or `"security-reviewer"`). Present when the session uses `--agent` or the hook fires inside a subagent. For subagents, the subagent's type takes precedence over the session's `--agent` value. See [SubagentStart](#subagentstart) for the values custom and plugin subagents report and how to write a matcher against a plugin-scoped name. |

Only [`SessionStart`](#sessionstart) hooks can receive a `model` field, and Claude Code doesn't always include it. [`PreModelSwitch`](#premodelswitch) and [`PostModelSwitch`](#postmodelswitch) hooks receive `from_model` and `to_model` instead, so use a PostModelSwitch hook to follow the model as it changes during a session.

There is no `$CLAUDE_MODEL` environment variable. The hook can read `$ANTHROPIC_MODEL` if you set it in your shell, but that value doesn't change when you switch models with `/model` during a session.

A hook process inherits the parent environment, apart from the `OTEL_*` exporter variables that Claude Code [removes from every subprocess it spawns](https://code.claude.com/docs/en/monitoring-usage.md#administrator-configuration) and, when [`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`](https://code.claude.com/docs/en/env-vars#variables) is set to `1`, the variables it strips. In a session that [gets the HIPAA configuration](https://code.claude.com/docs/en/hipaa-setup.md#check-how-developers-sign-in-and-connect), Claude Code also [removes Anthropic credentials](https://code.claude.com/docs/en/hipaa-setup.md#anthropic-credentials-in-commands-hooks-and-mcp-servers) from the hook's environment.

For example, a `PreToolUse` hook for a Bash command receives this on stdin:

```json theme={null}
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "scratchpad_dir": "/tmp/claude-1000/-home-user-my-project/abc123/scratchpad",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run test suite",
    "timeout": 120000,
    "run_in_background": false
  },
  "tool_use_id": "toolu_01ABC123..."
}
```

The `tool_name`, `tool_input`, and `tool_use_id` fields are event-specific. Each [hook event](#hook-events) section documents the additional fields for that event.

### Exit code output

When your hook's run finishes, Claude Code uses its exit code to decide whether to continue with the action that triggered it, such as a tool call or a prompt:

* **Success**: your hook exits 0. Claude Code applies any [JSON output](#json-output) fields your hook printed, and the action goes ahead unless those fields block or deny it. [Hooks that start a background process](#hooks-that-start-a-background-process) covers the exception.
* **Blocking error**: your hook exits 2. On [events that can block](#exit-code-2-behavior-per-event), Claude Code stops the action.
* **Non-blocking error**: your hook exits with any other code, or fails in some other way, such as not starting or printing invalid JSON. The action goes ahead, except for hooks [whose failure blocks the action](#block-the-action-when-a-hook-fails), for example a hook with `onFailure` set to `"block"`. On events such as `PreToolUse`, you see a `<hook name> hook error` notice in the transcript.

What your hook prints to stdout can change the outcome. For example, when a `PreToolUse` hook exits 1 but prints JSON that passes validation, that JSON can still decide what happens. To find your hook's outcome on an event such as `PreToolUse`, match what it printed to stdout in the first column with its exit code along the top:

| Stdout | Exit 0 | Exit 2 | Any other exit code |
| :- | :- | :- | :- |
| JSON object that passes [schema validation](#json-output) | Success. The fields apply | Blocking error. Claude Code still reads the fields, but they can't override the block | Success. Claude Code ignores the exit code, and the fields alone decide. For hooks [whose failure blocks the action](#block-the-action-when-a-hook-fails), the run counts as a failure instead |
| JSON that [can't be parsed](#exit-code-0) or fails schema validation | Non-blocking error. The notice carries the parse or validation message | Blocking error. Your stderr is the reason | Non-blocking error. The notice carries the parse or validation message |
| [Plain text](#exit-code-0), or nothing | Success | Blocking error. Your stderr is the reason | Non-blocking error. The notice carries the first line of your stderr |

Some events have their own rules:

* **`WorktreeCreate`**: any non-zero exit code makes worktree creation fail, whatever your JSON says.
* **`WorktreeRemove`**: any non-zero exit code makes worktree removal fail if the directory still exists afterward.
* **`Stop`, `SubagentStop`, `TaskCompleted`, and a plugin's `UserPromptSubmit` hook**: when your hook exits 2 with nothing on stdout and its stderr says a file is missing, such as `No such file or directory`, Claude Code treats the run as a non-blocking error.
* **`Elicitation` and `ElicitationResult`**: Claude Code applies your `hookSpecificOutput` when your hook exits 0, and ignores it on any other exit code.
* **Events that discard hook output, such as `StopFailure`**: Claude Code ignores your JSON on any exit code, apart from side-effect fields like `terminalSequence`, which still fire.

To check what exit code 2 does on your event, see [Exit code 2 behavior per event](#exit-code-2-behavior-per-event). To check which decision fields it honors, see [Decision control](#decision-control).

#### Exit code 0

Exit 0 means success, and is the intended exit code when you print JSON for structured control. When your hook exits 0 but prints JSON that can't be parsed or fails [schema validation](#json-output), the action goes ahead unless the hook is one [whose failure blocks the action](#block-the-action-when-a-hook-fails). Instead of a success with your fields applied, the run is a [non-blocking error](#exit-code-output).

To fix your output, use the parse or validation message that the `<hook name> hook error` notice carries. For a hook that isn't [async](#how-async-hooks-execute), your stdout counts as [JSON output](#json-output) only when you print one JSON object, on one line or several, with nothing around it but whitespace. Claude Code reads any other stdout as plain text or a parse failure:

* **Output that doesn't start with `{`, or that starts with `{` and doesn't end with `}`**: plain text. A JSON array and a quoted JSON string are plain text by this rule.
* **Two or more lines that each parse as JSON on their own, the first starting with `{` and the last ending with `}`**: plain text when no line is a JSON output object that sets a field. When one line is, the output is a parse failure, so print that object with nothing else on stdout.
* **Anything else that starts with `{` and ends with `}` but isn't valid JSON**: a parse failure.

For most events, Claude Code writes stdout to the debug log and doesn't show it in the transcript. The exceptions are `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, and `PostModelSwitch`, where Claude Code adds plain-text stdout as context that Claude can see and act on. On those events, Claude Code doesn't add stdout it failed to parse.

Claude never sees stderr from a hook that exits 0. To read it yourself on events such as `PreToolUse`, enable [debug logging](#debug-hooks). To surface a warning to Claude from a `PostToolUse` or `PostToolUseFailure` hook, exit 2 instead so [Claude sees the stderr](#exit-code-2-behavior-per-event) even though the tool already ran.

#### Exit code 2

Exit with code 2 to block the action. On [events that can block](#exit-code-2-behavior-per-event), Claude Code stops the action: a `PreToolUse` hook blocks the tool call, for example, and a `UserPromptSubmit` hook rejects the prompt.

The message that comes with the block is your hook's stderr. If your hook also printed JSON that makes a blocking decision, Claude Code uses that decision's reason instead.

Exit 2 blocks even when your hook prints JSON:

* **JSON that passes schema validation**: Claude Code still reads the [JSON output](#json-output) fields, but they can't override the block. Even a `permissionDecision` of `"allow"` doesn't let the action through. On `Elicitation` and `ElicitationResult`, an exit-2 hook's `hookSpecificOutput` is ignored.
* **JSON that fails schema validation**: the hook still blocks. Claude Code uses your stderr as the blocking reason and records the validation failure in the debug log.

This script blocks `rm` commands by exiting 2 and leaves every other command to the normal permission flow:

```bash theme={null}
#!/bin/bash
# Reads JSON input from stdin, checks the command
input=$(cat)
command=$(jq -r '.tool_input.command' <<<"$input")

if [[ "$command" == rm* ]]; then
  echo "Blocked: rm commands are not allowed" >&2
  exit 2  # Blocking error: tool call is prevented
fi

exit 0  # No decision: the normal permission flow applies
```

With this script registered as a `PreToolUse` hook on `Bash`, a command that starts with `rm` is blocked, and Claude receives the hook's stderr as the tool's error, prefixed with the event name, the tool name, and the hook's command:

```text theme={null}
PreToolUse:Bash hook error: [${CLAUDE_PROJECT_DIR}/.claude/hooks/no-rm.sh]: Blocked: rm commands are not allowed
```

#### Other exit codes

A `<hook name> hook error` notice with `Failed with non-blocking status code:` means your hook's exit code wasn't 0 or 2 and its stdout was plain text or empty. Unless the hook is one [whose failure blocks the action](#block-the-action-when-a-hook-fails), this is a [non-blocking error](#exit-code-output), so your hook didn't stop the action. To capture your hook's full stderr rather than the first line the notice shows, enable [debug logging](#debug-hooks).

For example, when a `PreToolUse` hook on `Bash` prints `something broke` to stderr and exits 1, the `PreToolUse:Bash hook error` notice carries this line:

```text theme={null}
Failed with non-blocking status code: something broke
```

If the notice carries the shell's `No such file or directory` message, as in the following line, the hook never ran, for example because its script path doesn't exist:

```text theme={null}
Failed with non-blocking status code: /bin/sh: /path/to/hook.sh: No such file or directory
```

If the path is wrong, correct it where the hook is configured. In shell form, when the script path doesn't exist or isn't executable, the shell exits with a code like 127 and the notice carries the interpreter's message. Unless the hook is one [whose failure blocks the action](#block-the-action-when-a-hook-fails), a hook that can't start is a non-blocking error too.

When you set up a policy hook, watch for this notice on its first run, because a mistyped path in `settings.json` means the hook never runs. To block the action when the hook can't start, set [`onFailure: "block"`](#block-the-action-when-a-hook-fails).

> [!WARNING]
>
> Exit code 1 without valid JSON output is a non-blocking error unless the hook is one [whose failure blocks the action](#block-the-action-when-a-hook-fails), even though 1 is the conventional Unix failure code. If your hook is meant to enforce a policy, use `exit 2`.

#### Timeouts

Apart from a command hook you run with [`async: true`](#run-hooks-in-the-background), Claude Code cancels a `command`, `http`, or `mcp_tool` hook that reaches its [`timeout`](#common-fields), discarding the hook's output, so on most events a timed-out hook renders no decision. On [`PreModelSwitch`](#premodelswitch), a hook canceled at its timeout blocks the model switch.

On `PreToolUse`, a timed-out `command`, `http`, or `mcp_tool` hook doesn't block the tool call, except for hooks [whose failure blocks the action](#block-the-action-when-a-hook-fails). The call continues through the normal [permission flow](https://code.claude.com/docs/en/permissions.md), so don't count on a stalled hook to act as a gate. To block the call when a `command` or `http` hook times out, set [`onFailure: "block"`](#block-the-action-when-a-hook-fails). An [Agent SDK callback hook](https://code.claude.com/docs/en/agent-sdk/hooks.md) that exceeds its timeout [blocks the tool call](#pretooluse).

#### Hooks that start a background process

If your command hook makes its decision in a background process and exits, a deny that process prints after Claude Code has stopped reading doesn't block the tool call. For a hook that isn't [async](#run-hooks-in-the-background), Claude Code finishes reading the hook's output shortly after the hook's own process exits.

Print the decision before you start a background process, and redirect that process's stdout and stderr. If your script prints an allow, then starts a background process without redirecting that process's stdout and stderr, Claude Code blocks the tool call. The hook error includes `refusing to honor the suspect capture`.

This `PreToolUse` hook script prints the decision with `policy-check.sh`, then uploads metrics in the background:

```bash theme={null}
#!/bin/bash
"$CLAUDE_PROJECT_DIR"/.claude/hooks/policy-check.sh || exit $?
"$CLAUDE_PROJECT_DIR"/.claude/hooks/upload-metrics.sh >/dev/null 2>&1 &
```

The rest of the script does this:

* **`|| exit $?`**: makes the check's exit code the hook's own, so a check that exits 2 to deny still blocks. Otherwise the hook exits with the last line's code, which is 0.
* **`>/dev/null 2>&1 &`**: runs `upload-metrics.sh` in the background with its output redirected, so it doesn't keep the hook's output open.

To test the script, make `policy-check.sh` exit 2, then trigger a tool call that the hook matches. The tool call is blocked.

#### Block the action when a hook fails

On most events, when a hook fails or times out, Claude Code still carries out the action. A policy hook with a wrong path or a crashing script then lets everything through. To block the action instead, set `"onFailure": "block"` on a `command` or `http` hook. Requires Claude Code v2.1.295 or later.

> [!NOTE]
>
> On Windows without Git Bash, a shell-form `PreToolUse` or `PermissionRequest` command hook that fails with `onFailure` unset can instead [block the tool call](#failed-hooks-on-windows-without-git-bash).

This `PreToolUse` hook in `.claude/settings.json` runs a project script before each Bash command, and blocks the command if the script fails:

```json theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/check-command.js"],
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

To test it, leave `check-command.js` missing and ask Claude to run a Bash command such as `ls`. Claude Code blocks the call, and the error includes `failed; blocking because onFailure is "block"` followed by node's own error output, trimmed here to one line:

```text theme={null}
PreToolUse:Bash hook error: [node ${CLAUDE_PROJECT_DIR}/.claude/hooks/check-command.js]: failed; blocking because onFailure is "block"
Error: Cannot find module '/path/to/project/.claude/hooks/check-command.js'
```

After a timeout, the message says `timed out` instead of `failed`. Without `onFailure` set, the same missing script is a non-blocking error and `ls` runs.

Each of these counts as a failure:

* **Can't start**: a command hook fails to start, for example because the script or executable doesn't exist
* **Exit code other than 0 or 2**: counts for a command hook even if it printed JSON that allows the action, such as `permissionDecision: "allow"`. To return a JSON decision, exit 0
* **HTTP error**: an HTTP hook's connection fails, or the response status isn't 2xx
* **Timeout**: the hook reaches its [`timeout`](#common-fields)
* **Invalid output**: the JSON output [can't be parsed](#exit-code-0) or fails [schema validation](#json-output). For an HTTP hook, a 2xx body that is neither empty nor a JSON object also counts. Plain-text stdout from a command hook isn't a failure

With `"block"` set, a failure does what [exit code 2 does on that event](#exit-code-2-behavior-per-event), except on `PermissionRequest`, where it denies the request. For example, a `PreToolUse` failure blocks the tool call and a `UserPromptSubmit` failure blocks the prompt.

The field has no effect on these hooks:

* **`Stop`, `SubagentStop`, `TaskCompleted`, and `TeammateIdle` hooks**: exit code 2 on these events sends Claude back to keep working, and Claude can't repair a hook that won't run
* **Background command hooks**: command hooks that set [`async` or `asyncRewake`](#run-hooks-in-the-background)

#### Failed hooks on Windows without Git Bash

If the error for a blocked tool call includes this text, a `PreToolUse` or `PermissionRequest` command hook failed or timed out and blocked the call:

```text theme={null}
blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict.
```

If the error also says `PowerShell started no program`, start with [the fixes for a `command` that is only quoted strings](#powershell-started-no-program), which PowerShell prints instead of running.

Without Git Bash, any exit code other than 0 or 2 from that hook counts as a [failure](#block-the-action-when-a-hook-fails), even when it prints JSON that doesn't deny the call. To find out why the hook failed, check the [debug log](#debug-hooks). Then pick the fix that matches your hook:

* **The call should go ahead when the hook fails**: add [`"onFailure": "continue"`](#block-the-action-when-a-hook-fails) to the hook
* **The hook exits 1 to warn but must block when it crashes**: with `"onFailure": "continue"`, the call goes ahead on exit code 1, warning or crash alike. Add `"onFailure": "block"` instead, and have the script exit 0 where it warns, so those calls go ahead. To still show the warning on `PreToolUse`, print it to stdout as the [`systemMessage`](#json-output) field of one JSON object.
* **The hook is written for Bash**: without Git Bash, a [shell-form](#exec-form-and-shell-form) hook with no `shell` set runs in PowerShell, where it can fail. Install [Git for Windows](https://git-scm.com/downloads/win), or set [`CLAUDE_CODE_GIT_BASH_PATH`](https://code.claude.com/docs/en/env-vars) if Git Bash is installed where Claude Code doesn't find it. Then start a new session.
* **The hook runs one `.exe`, not a `.cmd` or `.bat` file**: put the program in `command` and its arguments in `args` to use exec form, and add `"onFailure": "block"`. Claude Code then starts the program with no shell. Without `"onFailure": "block"`, the call can go ahead when the program fails, is missing, or times out
* **A PowerShell guard hook that must block on failure**: with `onFailure` unset, it stops doing so once Git for Windows is installed and Claude Code finds Git Bash. Add `"onFailure": "block"` so a failure or a timeout blocks the call with or without Git Bash. Also set `"shell": "powershell"` so the hook keeps running in PowerShell from then on instead of in Git Bash

Before v2.1.309, the message read `blocking because Git Bash wasn't found and this hook doesn't set "shell" to "powershell", so only exit code 0 or 2 counts as its verdict.`

#### PowerShell started no program

A hook with this error ran in PowerShell, which prints a `command` that is only quoted strings, such as `"command": "\"C:\\Tools\\guard.exe\""`, instead of running it.

* **To print text, such as JSON**: set `"shell": "powershell"`, and the hook exits 0
* **To run a `.ps1`, `.cmd`, or `.bat` file, or a `.exe` whose path has a variable**: set `"shell": "powershell"` and put `&` before the quoted path. Leave `$HOME` as written, and spell environment variables as the [`check.ps1` example](#reference-scripts-by-path-in-powershell-hooks) spells `$env:CLAUDE_PROJECT_DIR`
* **To run one `.exe` at a path without `$`**: remove the inner quotes from `command`, then apply the [fix for a hook that runs one `.exe`](#failed-hooks-on-windows-without-git-bash), writing `"args": []` if the program takes no arguments
* **To run a script written for Bash**: apply the [fix for a hook written for Bash](#failed-hooks-on-windows-without-git-bash)

#### Exit code 2 behavior per event

Exit code 2 is the way a hook signals "stop, don't do this." The effect depends on the event, because some events represent actions that can be blocked (like a tool call that hasn't happened yet) and others represent things that already happened or can't be prevented.

| Hook event | Can block? | What happens on exit 2 |
| :- | :- | :- |
| `PreToolUse` | Yes | Blocks the tool call |
| `PermissionRequest` | No | Exit code 2 isn't honored for this event and the permission flow proceeds unchanged. Deny through the [`decision` object](#permissionrequest-decision-control) instead |
| `UserPromptSubmit` | Yes | Blocks the prompt, so it never reaches Claude. See [What a blocked prompt leaves behind](#what-a-blocked-prompt-leaves-behind) |
| `UserPromptExpansion` | Yes | Blocks the expansion |
| `Stop` | Yes | Prevents Claude from stopping, continues the conversation |
| `SubagentStop` | Yes | Prevents the subagent from stopping |
| `TeammateIdle` | Yes | Prevents the teammate from going idle, so it continues working |
| `TaskCreated` | Yes | Rolls back the task creation |
| `TaskCompleted` | Yes | Prevents the task from being marked as completed |
| `ConfigChange` | Yes | Blocks the configuration change from taking effect (except `policy_settings`) |
| `StopFailure` | No | Output and exit code are ignored, except `terminalSequence` |
| `PostToolUse` | No | Shows stderr to Claude; the tool already ran |
| `PostToolUseFailure` | No | Shows stderr to Claude; the tool already failed |
| `PostToolBatch` | Yes | Stops the agentic loop before the next model call |
| `PermissionDenied` | No | Exit code and stderr are ignored because the denial already occurred. Use JSON `hookSpecificOutput.retry: true` to tell the model it may retry; Claude Code ignores `retry: true` for [no-verdict denials](#permissiondenied-decision-control) |
| `Notification` | No | Exit code and stderr are ignored |
| `SubagentStart` | No | Shows stderr to user only |
| `SessionStart` | No | Shows stderr to user only |
| `Setup` | No | Exit code and stderr are ignored |
| `SessionEnd` | No | Shows stderr to user only |
| `CwdChanged` | No | Shows stderr to user only |
| `DirectoryAdded` | No | Stderr goes to the debug log; the directory is already added |
| `FileChanged` | No | Shows stderr to user only |
| `PreCompact` | Yes | Blocks compaction |
| `PostCompact` | No | Shows stderr to user only |
| `PreModelSwitch` | Yes | Blocks the model switch and shows stderr to the user |
| `PostModelSwitch` | No | Shows stderr to user only; the model already switched |
| `Elicitation` | Yes | Declines the request, and no dialog appears |
| `ElicitationResult` | Yes | Blocks the response (action becomes decline) |
| `WorktreeCreate` | Yes | Any non-zero exit code causes worktree creation to fail |
| `WorktreeRemove` | Yes | Any non-zero exit code causes worktree removal to fail if the directory still exists afterward. See [WorktreeRemove](#worktreeremove) for what happens to the directory |
| `InstructionsLoaded` | No | Exit code is ignored |
| `MessageDisplay` | No | The original text is displayed |

For `SessionStart`, `SubagentStart`, and `PostModelSwitch`, Claude Code renders the exit code 2 stderr in the transcript as a `<hook name> hook error` notice, the same way it renders a [non-blocking error](#exit-code-output). Claude doesn't see it, and the session or subagent proceeds. For `SubagentStart`, the notice appears in the subagent's own transcript, not in the parent conversation.

### HTTP response handling

HTTP hooks use HTTP status codes and response bodies instead of exit codes and stdout. To block the action when the request fails or returns a non-2xx status, set [`onFailure: "block"`](#block-the-action-when-a-hook-fails). To block a tool call or deny a permission, return a 2xx response with a JSON body containing the appropriate [decision fields](#decision-control).

After a [non-blocking error](#exit-code-output), the action goes ahead unless the hook is one [whose failure blocks the action](#block-the-action-when-a-hook-fails). Except on events with their own failure contract in the [per-event table](#exit-code-2-behavior-per-event), such as `WorktreeCreate`, you get these results for each response or failure:

* **2xx with an empty body**: success, equivalent to exit code 0 with no output
* **2xx with a JSON object body**: parsed using the same [JSON output](#json-output) schema as command hooks. A body that fails schema validation is a non-blocking error
* **2xx with any other body, such as plain text**: non-blocking error, handled the same as a non-2xx status. Claude Code doesn't add the text to Claude's context
* **Non-2xx status**: non-blocking error
* **Connection failure**: non-blocking error
* **Timeout**: the hook is canceled, as described under [Timeouts](#timeouts)

### JSON output

Exit codes only let you block or stay silent, but JSON output gives you finer-grained control. Instead of exiting with code 2 to block, exit 0 and print a JSON object to stdout. Claude Code reads specific fields from that JSON to control behavior, including [decision control](#decision-control) for blocking, allowing, or escalating to the user.

> [!NOTE]
>
> Choose one approach per hook: either use exit codes alone for signaling, or exit 0 and print JSON for structured control. If you mix them, exit 2 keeps its [blocking effect](#exit-code-2-behavior-per-event), and Claude Code still reads the JSON fields, with the one elicitation exception noted under [Exit code 2](#exit-code-2).

Print nothing but the JSON object to stdout. For a hook that isn't [async](#how-async-hooks-execute), other text there, such as a line your shell profile echoes at startup, keeps Claude Code from reading the object as JSON, and [Hook JSON has no effect](https://code.claude.com/docs/en/hooks-guide.md#hook-json-has-no-effect) shows how to find and silence that text.

A hook's `additionalContext`, `systemMessage`, and `initialUserMessage` strings, and its plain stdout, are capped at 10,000 characters:

* **Scope**: Claude Code measures each string on its own, even when several hooks run for the same event. For JSON output, each field is measured separately; plain stdout is measured whole.
* **Over the limit**: Claude Code saves the output to a file in the session directory and replaces it with the file path and a preview of up to the first 2,000 characters. A large valid Bash result is handled the same way, described under [Output limits](https://code.claude.com/docs/en/tools-reference.md#output-limits). Unlike that Bash ceiling, this cap has no setting or environment variable to raise it.
* **Reading the file**: Claude Code doesn't ask Claude to read the file, so keep anything Claude must always see within the cap.

The JSON object supports three kinds of fields:

* **Universal fields** like `continue` are listed in the table below. Every event accepts them, but some events discard them or deliver `systemMessage` somewhere other than the transcript. Each event's section says so. `terminalSequence` works on those events too, with the exceptions listed under [Emit terminal notifications](#emit-terminal-notifications).
* **Top-level `decision` and `reason`** are used by some events to block or provide feedback.
* **`hookSpecificOutput`** is a nested object for events that need richer control. It requires a `hookEventName` field set to the event name.

| Field | Default | Description |
| :- | :- | :- |
| `continue` | `true` | If `false`, Claude stops processing entirely after the hook runs. Takes precedence over any event-specific decision fields |
| `stopReason` | none | Message shown to the user when `continue` is `false`. It stays in the conversation, so Claude sees it if the conversation continues |
| `suppressOutput` | `false` | Has no effect: Claude Code accepts the field but doesn't act on it. A successful hook's stdout is never shown in the transcript and is recorded in the debug log |
| `systemMessage` | none | Warning message shown to the user. In [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md) and [`--output-format stream-json`](https://code.claude.com/docs/en/headless) output, it can arrive as an [`SDKInformationalMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkinformationalmessage) |
| `terminalSequence` | none | A terminal escape sequence for Claude Code to emit on your behalf, such as a desktop notification, window title, or bell. Restricted to OSC `0`/`1`/`2`/`9`/`99`/`777` and BEL. If the value contains anything outside the allowlist, the field is ignored. Use this instead of writing to `/dev/tty`, which is unavailable to hooks |

To stop Claude entirely:

```json theme={null}
{ "continue": false, "stopReason": "Build failed, fix errors before continuing" }
```

For `PreToolUse` and `PostToolUse` hooks, the stop applies even when the tool call fails or completes while Claude is still streaming a response.

#### Emit terminal notifications

Hooks run without a controlling terminal, so writing escape sequences directly to `/dev/tty` fails. Instead, return the escape sequence in the `terminalSequence` field and Claude Code emits it for you through its own terminal write path. This is race-free, works inside tmux and GNU screen, and works on Windows where there is no `/dev/tty`.

The field accepts a string of one or more allowlisted escape sequences:

* OSC `0`, `1`, `2`: window and icon titles
* OSC `9`: iTerm2, ConEmu, Windows Terminal, and WezTerm notifications, including `9;4` taskbar progress
* OSC `99`: Kitty notifications
* OSC `777`: urxvt, Ghostty, and Warp notifications
* Bare BEL

Sequences may be terminated with BEL or with ST. Anything outside the allowlist, including CSI cursor and color sequences, OSC palette sequences, OSC 8 hyperlinks, OSC 52 clipboard writes, and OSC 1337, is rejected and the field is ignored.

Claude Code writes the sequence itself when it processes your hook's output, so the field works on events that discard `systemMessage` and `continue`, such as `Notification` and `StopFailure`. It has two limits:

* Claude Code writes the sequence only in an interactive session, and only while its interface is on screen. In non-interactive mode with the `-p` flag and in the Agent SDK, it ignores the field.
* A `WorktreeCreate` command hook can't return JSON, because Claude Code reads its stdout as the worktree path. An HTTP `WorktreeCreate` hook returns JSON and can include the field.

The example below fires a desktop notification from a `Notification` hook. The escape sequence is built with `printf` octal escapes so the control bytes never appear on the shell command line, and `jq -n --arg` builds the JSON output so quotes, backslashes, and newlines in the notification message are escaped correctly:

```bash theme={null}
#!/bin/bash
# Notification hook: ping the desktop when Claude Code needs attention.
input=$(cat)
title="Claude Code"
body=$(jq -r '.message // "Needs your attention"' <<<"$input")
seq=$(printf '\033]777;notify;%s;%s\007' "$title" "$body")
jq -nc --arg seq "$seq" '{terminalSequence: $seq}'
```

The `{ "terminalSequence": "..." }` shape is the same from any shell or language.

#### Add context for Claude

The `additionalContext` field passes a string from your hook into Claude's context window. Claude Code wraps the string in a [system reminder](https://code.claude.com/docs/en/glossary.md#system-reminder) and inserts it into the conversation at the point where the hook fired. Claude reads the reminder on the next model request, but it doesn't appear as a chat message in the interface.

Return `additionalContext` inside `hookSpecificOutput` alongside the event name:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "This file is generated. Edit src/schema.ts and run `bun generate` instead."
  }
}
```

Where the reminder appears depends on the event:

* [SessionStart](#sessionstart) and [SubagentStart](#subagentstart): at the start of the conversation, before the first prompt
* [UserPromptSubmit](#userpromptsubmit) and [UserPromptExpansion](#userpromptexpansion): alongside the submitted prompt
* [PreToolUse](#pretooluse), [PostToolUse](#posttooluse), [PostToolUseFailure](#posttoolusefailure), and [PostToolBatch](#posttoolbatch): next to the tool result
* [Stop](#stop) and [SubagentStop](#subagentstop): at the end of the turn. The conversation continues so Claude can act on the feedback. See [Stop decision control](#stop-decision-control)
* [PostModelSwitch](#postmodelswitch): with the next request after the switch. See [PostModelSwitch decision control](#postmodelswitch-decision-control) for timing

When several hooks return `additionalContext` for the same event, Claude receives all of the values.

If your string contains a `<system-reminder>` or `</system-reminder>` tag, Claude receives the string with that tag's `<` replaced by `&lt;`.

If a value exceeds 10,000 characters, Claude Code writes the text to a file in the session directory and passes Claude the file path with a preview of up to the first 2,000 characters instead. Claude can read the file, but Claude Code doesn't ask it to.

Use `additionalContext` for information Claude should know about the current state of your environment or the operation that just ran:

* **Environment state**: the current branch, deployment target, or active feature flags
* **Conditional project rules**: which test command applies to the file just edited, which directories are read-only in this worktree
* **External data**: open issues assigned to you, recent CI results, content fetched from an internal service

For instructions that never change, prefer [CLAUDE.md](https://code.claude.com/docs/en/memory.md). It loads without running a script and is the standard place for static project conventions.

Write the text as factual statements rather than imperative system instructions. Phrasing such as "The deployment target is production" or "This repo uses `bun test`" reads as project information. Text framed as out-of-band system commands can trigger Claude's prompt-injection defenses, which causes Claude to surface the text to you instead of treating it as context.

Claude Code saves the injected text in the session transcript. For mid-session events like `PostToolUse` or `UserPromptSubmit`, when you resume with `--continue` or `--resume`, Claude Code replays the saved text rather than re-running the hook for past turns, so values like timestamps or commit SHAs become stale. `SessionStart` hooks run again on resume with `source` set to `"resume"`, or `"fork"` if you added `--fork-session`, so they can refresh their context.

#### Decision control

Not every event supports blocking or controlling behavior through JSON. The events that do each use a different set of fields to express that decision. Use this table as a quick reference before writing a hook:

| Events | Decision pattern | Key fields |
| :- | :- | :- |
| UserPromptSubmit, UserPromptExpansion, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop, ConfigChange, PreCompact | Top-level `decision` | `decision: "block"`, `reason`. Stop and SubagentStop also accept `hookSpecificOutput.additionalContext` for [non-error feedback that continues the conversation](#stop-decision-control) |
| TeammateIdle, TaskCompleted | Exit code or `continue: false` | Exit code 2 blocks the action with stderr feedback. JSON `{"continue": false, "stopReason": "..."}` also stops the teammate entirely, matching `Stop` hook behavior; [TaskCompleted ignores it when the `TaskUpdate` tool triggered the event](#taskcompleted-decision-control) |
| TaskCreated | Exit code or top-level `decision` | Exit code 2 or `decision: "block"` [cancels the task](#taskcreated-decision-control) and returns the message to Claude. `continue: false` is ignored |
| PreToolUse | `hookSpecificOutput` | `permissionDecision` (allow/deny/ask/defer), `permissionDecisionReason` |
| PreModelSwitch | `hookSpecificOutput` or top-level `decision` | `permissionDecision` (allow/deny/ask), `permissionDecisionReason`. `decision: "block"` also [cancels the switch](#premodelswitch-decision-control) |
| PermissionRequest | `hookSpecificOutput` | `decision.behavior` (allow/deny) |
| PermissionDenied | `hookSpecificOutput` | `retry: true` tells the model it may retry the denied tool call; Claude Code ignores it for [no-verdict denials](#permissiondenied-decision-control) |
| WorktreeCreate | path return | Command hook prints path on stdout; HTTP hook returns `hookSpecificOutput.worktreePath`. Hook failure or missing path fails creation |
| WorktreeRemove | Exit code | Any non-zero exit code makes the removal fail if the directory still exists afterward. JSON output is discarded |
| Elicitation, ElicitationResult | `hookSpecificOutput` or top-level `decision` | `action` (accept/decline/cancel), `content` (form field values). `decision: "block"` also [declines](#other-ways-to-decline-an-elicitation) |
| MessageDisplay | `hookSpecificOutput` | `displayContent` replaces the displayed text on screen. Display-only: the transcript and what Claude sees keep the original |
| SessionStart, SubagentStart, PostModelSwitch | Context only | `hookSpecificOutput.additionalContext` adds context for Claude. SessionStart also accepts [`initialUserMessage`, `watchPaths`, `sessionTitle`, and `reloadSkills`](#sessionstart-decision-control). No blocking or decision control |
| Setup, Notification, SessionEnd, PostCompact, InstructionsLoaded, StopFailure, CwdChanged, DirectoryAdded, FileChanged | None | No decision control. Used for side effects like logging or cleanup |

A few events can also rewrite content rather than only allow or block it:

* `PreToolUse`: `updatedInput` directly under `hookSpecificOutput` replaces a tool's arguments before it runs. See [PreToolUse decision control](#pretooluse-decision-control)
* `PermissionRequest`: `updatedInput` inside the `decision` object. See [PermissionRequest decision control](#permissionrequest-decision-control)
* `PostToolUse`: `updatedToolOutput` replaces the tool's result. See [PostToolUse decision control](#posttooluse-decision-control)
* `UserPromptSubmit`: can't replace the prompt; it only injects `additionalContext` alongside it

For redaction or transformation use cases, intercept at `PreToolUse` for outbound tool inputs and `PostToolUse` for inbound tool results.

Here are examples of each pattern in action:

**Top-level decision**

The only value for `decision` is `"block"`. To allow the action to proceed, omit `decision` from your JSON, or exit 0 without any JSON at all:

```json theme={null}
{
  "decision": "block",
  "reason": "Test suite must pass before proceeding"
}
```

**PreToolUse**

Uses `hookSpecificOutput` for richer control: allow, deny, or escalate to the user. You can also modify tool input before it runs or inject additional context for Claude. See [PreToolUse decision control](#pretooluse-decision-control) for the full set of options.

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Database writes are not allowed"
  }
}
```

**PermissionRequest**

Uses `hookSpecificOutput` to allow or deny a permission request on behalf of the user. When allowing, you can also modify the tool's input or apply permission rules so the user isn't prompted again. See [PermissionRequest decision control](#permissionrequest-decision-control) for the full set of options.

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": {
        "command": "npm run lint"
      }
    }
  }
}
```

For extended examples including Bash command validation, prompt filtering, and auto-approval scripts, see [What you can automate](https://code.claude.com/docs/en/hooks-guide.md#what-you-can-automate) in the guide and the [Bash command validator reference implementation](https://github.com/anthropics/claude-code/blob/main/examples/hooks/bash_command_validator_example.py).

## Hook events

Each event corresponds to a point in Claude Code's lifecycle where hooks can run. The sections below are ordered to match the lifecycle: from session setup through the agentic loop to session end. Each section describes when the event fires, what matchers it supports, the JSON input it receives, and how to control behavior through output.

### SessionStart

Runs when Claude Code starts a new session or resumes an existing session. Useful for loading development context like existing issues or recent changes to your codebase, or setting up environment variables. For static context that doesn't require a script, use [CLAUDE.md](https://code.claude.com/docs/en/memory.md) instead.

SessionStart runs on every session, so keep these hooks fast. Only `type: "command"` and `type: "mcp_tool"` hooks are supported. See [MCP tool hook fields](#mcp-tool-hook-fields) for when `mcp_tool` hooks run.

The matcher value corresponds to how the session was initiated:

| Matcher | When it fires |
| :- | :- |
| `startup` | New session |
| `resume` | `--resume`, `--continue`, or `/resume` |
| `clear` | `/clear` |
| `compact` | Auto or manual compaction |
| `fork` | A new session forked from an existing one: `--fork-session` with `--resume` or `--continue`, the `/fork` background copy, `/branch`, or a conversation you [move to the background](https://code.claude.com/docs/en/agent-view.md#from-inside-a-session) |

When you start an interactive session, resume a conversation at launch with `--continue` or `--resume`, or run `/clear`, SessionStart hooks run in the background. You can type right away, and a conversation you resumed appears without waiting for the hooks. Claude's first response still waits for the hooks to finish, so their context reaches Claude.

When you switch conversations with `/resume` inside a session, the switch waits for the hooks to finish instead. If you run `/clear` or switch to another conversation while background hooks are still running, nothing they return applies to the session.

The same wait applies at launch, including a resumed session: a prompt you send while SessionStart hooks are still running doesn't reach Claude until they finish.

During either wait, press `Esc` to take the prompt back into the input without sending it. The hooks keep running.

#### SessionStart input

In addition to the [common input fields](#common-input-fields), SessionStart hooks receive `source` and optionally `model`, `agent_type`, and `session_title`:

| Field | Description |
| :- | :- |
| `source` | How the session started: `"startup"` for new sessions, `"resume"` for resumed sessions, `"clear"` after `/clear`, `"compact"` after compaction, or `"fork"` for a new session forked from an existing one |
| `model` | The active model identifier. It can be omitted, for example after `/clear` or when a session is restored through conversation recovery, so check for the field before reading it |
| `agent_type` | The agent name, present when you start Claude Code with `claude --agent <name>` |
| `session_title` | The session's custom title, present when one is set, for example with `--name`, `/rename`, a hook's `sessionTitle` output, or the Agent SDK's `renameSession()`. A hook that emits `sessionTitle` can check this field first to avoid overwriting an existing custom title |

A session you haven't named can still have a [generated title](https://code.claude.com/docs/en/sessions.md#name-your-sessions). That title isn't a custom title and doesn't appear in `session_title`.

When `source` is `"resume"` or `"fork"` and the transcript contains at least one response from Claude, SessionStart hooks also receive the four fields below. Your hook can use them to report what resuming a stale conversation costs before the first request, for example in a [`systemMessage`](#json-output). These fields require Claude Code v2.1.251 or later.

| Field | Description |
| :- | :- |
| `seconds_since_last_response` | Wall-clock seconds since the last response in the resumed transcript |
| `context_tokens` | Tokens the first request of the resumed session re-sends as its prompt |
| `prompt_cache_likely_expired` | `true` when the last response is older than the session's [prompt cache lifetime](https://code.claude.com/docs/en/prompt-caching.md#cache-lifetime) or a later compaction replaced the cached conversation |
| `estimated_cache_write_usd` | Estimated cost in US dollars of writing `context_tokens` to the prompt cache on the session's model, excluding the response |

This example shows the input for a session resumed 90 minutes after its last response:

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionStart",
  "source": "resume",
  "model": "claude-opus-5",
  "seconds_since_last_response": 5400,
  "context_tokens": 182340,
  "prompt_cache_likely_expired": true,
  "estimated_cache_write_usd": 1.1396
}
```

#### SessionStart decision control

A SessionStart hook can add context for Claude, supply the first user message, set the session title, watch files, and reload skills. Return the field for each one, in addition to the [JSON output fields](#json-output) available to all hooks:

| Field | Description |
| :- | :- |
| `additionalContext` | String added to Claude's context at the start of the conversation, before the first prompt. See [Add context for Claude](#add-context-for-claude) for how the text is delivered and what to put in it |
| `initialUserMessage` | String used as the first user message of the session, in [non-interactive mode](https://code.claude.com/docs/en/headless.md) with the `-p` flag. It becomes the first turn even if you pass no prompt. A prompt you do pass follows as the next turn |
| `sessionTitle` | Sets the session title, with the same effect as `/rename`. Applies when `source` is `"startup"`, `"resume"`, or `"fork"` |
| `watchPaths` | Array of absolute paths to watch for [FileChanged](#filechanged) events during this session |
| `reloadSkills` | Boolean. When `true`, Claude Code re-scans the [skill](https://code.claude.com/docs/en/skills.md) and command directories after the SessionStart hooks complete. See [Reload skills that a hook installs](#reload-skills-that-a-hook-installs) |

This output adds context and names the session:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Current branch: feat/auth-refactor\nUncommitted changes: src/auth.ts, src/login.tsx\nActive issue: #4211 Migrate to OAuth2",
    "sessionTitle": "auth-refactor"
  }
}
```

A hook that only adds context can print it without building JSON, because Claude Code adds a SessionStart hook's [plain-text stdout](#exit-code-0) to Claude's context.

If your plugin's SessionStart hook supplies `initialUserMessage` or `sessionTitle`, install the plugin before the session starts. Claude Code ignores both fields from a plugin that finishes installing after the SessionStart hooks have run.

#### Reload skills that a hook installs

To make skills that a SessionStart hook installs available in the same session, return `reloadSkills`. Skill discovery normally runs before SessionStart hooks finish, so without it, files a hook writes into `~/.claude/skills/` or `.claude/skills/` can be missing when the first prompt runs.

This example syncs a shared skills repository and requests the re-scan:

```bash theme={null}
#!/bin/bash

git -C ~/.claude/skills/team-skills pull --quiet 2>/dev/null || \
  git clone --quiet https://git.example.com/your-org/team-skills.git ~/.claude/skills/team-skills

echo '{"hookSpecificOutput": {"hookEventName": "SessionStart", "reloadSkills": true}}'
```

The repository URL is a placeholder. Replace it with your own skills repository.

#### Persist environment variables

SessionStart hooks have access to the `CLAUDE_ENV_FILE` environment variable, which provides a file path where you can persist environment variables for the shell commands Claude runs later in the session.

To set individual environment variables, write `export` statements to `CLAUDE_ENV_FILE`. Use append (`>>`) to preserve variables set by other hooks:

```bash theme={null}
#!/bin/bash

if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export NODE_ENV=production' >> "$CLAUDE_ENV_FILE"
  echo 'export DEBUG_LOG=true' >> "$CLAUDE_ENV_FILE"
  echo 'export PATH="$PATH:./node_modules/.bin"' >> "$CLAUDE_ENV_FILE"
fi

exit 0
```

To capture all environment changes from setup commands, compare the exported variables before and after:

```bash theme={null}
#!/bin/bash

ENV_BEFORE=$(export -p | sort)

# Run your setup commands that modify the environment
source ~/.nvm/nvm.sh
nvm use 20

if [ -n "$CLAUDE_ENV_FILE" ]; then
  ENV_AFTER=$(export -p | sort)
  comm -13 <(echo "$ENV_BEFORE") <(echo "$ENV_AFTER") >> "$CLAUDE_ENV_FILE"
fi

exit 0
```

Each Bash command runs the file's contents as shell code before the command itself, so a line there can use anything Bash evaluates, such as the `$PATH` reference in `export PATH="$PATH:./node_modules/.bin"`.

##### Persisted variables in PowerShell commands

[PowerShell](https://code.claude.com/docs/en/tools-reference.md#powershell-tool) commands receive the variables from `CLAUDE_ENV_FILE` too, in Claude Code v2.1.296 or later, but PowerShell never runs the file. Claude Code reads the assignments out of it and copies them into the PowerShell command's environment instead. It does so only when every line is one of the following, across what every hook in this session wrote and any script you [set `CLAUDE_ENV_FILE` to](https://code.claude.com/docs/en/env-vars) before launch:

* A blank line or a `#` comment
* One assignment at the start of the line, written `export NAME=value`, `declare -x NAME=value`, or `NAME=value`, with a value Bash would use exactly as written, made of any mix of these parts: unquoted text that uses only letters, digits, and the characters `_ @ % + = : , . / -`, text in single quotes, and text in double quotes where any `$`, backtick, or `"` inside is escaped with a backslash

If any line is of another kind, such as `export PATH="$PATH:./node_modules/.bin"` with its unescaped `$PATH`, a `source` command, or the `$'...'` strings that `direnv export bash` prints, PowerShell commands receive none of the variables, and `claude --debug` logs `Session environment is not all plain assignments`. Bash commands still receive all of them. On Windows, PowerShell commands also don't receive a variable whose value contains `/` or `\`, because Git Bash and Windows write paths differently. A [sandboxed](https://code.claude.com/docs/en/sandboxing.md) PowerShell command receives none of the variables.

> [!NOTE]
>
> `CLAUDE_ENV_FILE` is available for SessionStart, [Setup](#setup), [CwdChanged](#cwdchanged), and [FileChanged](#filechanged) hooks. Other hook events don't have access to this variable, and neither does a hook that runs in PowerShell, whether through [`"shell": "powershell"`](#command-hook-fields) or by default on Windows without Git Bash.

### Setup

Fires only when you launch Claude Code with `--init-only`, or with `--init` or `--maintenance` in [non-interactive mode](https://code.claude.com/docs/en/headless.md) with the `-p` flag. It doesn't fire on normal startup. Use it for one-time dependency installation or scheduled cleanup that you trigger explicitly from CI or scripts, separate from normal session startup. For per-session initialization, use [SessionStart](#sessionstart) instead.

The matcher value corresponds to the CLI flag that triggered the hook:

| Matcher | When it fires |
| :- | :- |
| `init` | `claude --init-only` or `claude -p --init` |
| `maintenance` | `claude -p --maintenance` |

When you run `claude --init-only`, Claude Code runs Setup hooks and `SessionStart` hooks with the `startup` matcher, then exits without starting a conversation.

When you start or continue a conversation with `-p`, you also need to supply a prompt, as an argument or piped on stdin. You can skip the prompt when a `SessionStart` hook supplies [`initialUserMessage`](#sessionstart-decision-control) or when you resume a session with a [deferred tool call](#defer-a-tool-call-for-later).

On success, `--init-only` prints nothing to the terminal. To confirm the hooks ran, start with `claude --debug-file <path> --init-only`, replacing `<path>` with a log file location, and check the log for the Setup and SessionStart hook entries.

Because Setup doesn't fire on every launch, a plugin that needs a dependency installed can't rely on Setup alone. The practical pattern is to check for the dependency on first use and install on miss, for example a hook or skill that tests for `${CLAUDE_PLUGIN_DATA}/node_modules` and runs `npm install` if absent. See the [persistent data directory](https://code.claude.com/docs/en/plugins/components.md#path-variables-and-persistent-data) for where to store installed dependencies. If you distribute your plugin through a marketplace, you may not need this pattern: Claude Code [installs eligible Node.js package dependencies automatically](https://code.claude.com/docs/en/plugins/loading.md#node-js-package-dependencies) when it caches the plugin.

#### Setup input

In addition to the [common input fields](#common-input-fields), Setup hooks receive a `trigger` field set to either `"init"` or `"maintenance"`:

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "Setup",
  "trigger": "init"
}
```

#### Setup decision control

Setup hooks can't block; execution continues on any exit code. On every exit code, Claude Code discards a Setup hook's [JSON output fields](#json-output), such as `systemMessage`, `continue`, and `hookSpecificOutput.additionalContext`. With `-p`, a Setup hook's stdout, stderr, and exit code appear in the run's output only as [`hook_response` events](https://code.claude.com/docs/en/headless#read-session-metadata) when you launch with `--output-format stream-json --verbose`.

Setup hooks have access to `CLAUDE_ENV_FILE`. If your hook writes variables to that file, they persist into subsequent Bash commands for the session, as in [SessionStart hooks](#persist-environment-variables). Only `type: "command"` hooks run on `Setup`. A `type: "mcp_tool"` hook on `Setup` is always skipped, as described under [MCP tool hook fields](#mcp-tool-hook-fields).

### InstructionsLoaded

Fires when a `CLAUDE.md` or `.claude/rules/*.md` file is loaded into context. This event fires at session start for eagerly loaded files and again later when files are lazily loaded, for example when Claude accesses a subdirectory that contains a nested `CLAUDE.md` or when conditional rules with `paths:` frontmatter match. The hook doesn't support blocking or decision control. It runs asynchronously for observability purposes.

This event doesn't fire when Claude [reads `AGENTS.md` directly](https://code.claude.com/docs/en/memory#agents-md) through the **Project instructions** setting. It does fire when a `CLAUDE.md` imports your `AGENTS.md`, with `load_reason` set to `include` as for any other imported file, and when `CLAUDE.md` is a symlink to it, as a normal `CLAUDE.md` load.

The matcher runs against `load_reason`. For example, use `"matcher": "session_start"` to fire only for files loaded at session start, or `"matcher": "path_glob_match|nested_traversal"` to fire only for lazy loads.

#### InstructionsLoaded input

In addition to the [common input fields](#common-input-fields), InstructionsLoaded hooks receive these fields:

| Field | Description |
| :- | :- |
| `file_path` | Absolute path to the instruction file that was loaded |
| `memory_type` | Scope of the file: `"User"`, `"Project"`, `"Local"`, or `"Managed"` |
| `load_reason` | Why the file was loaded: `"session_start"`, `"nested_traversal"`, `"path_glob_match"`, `"include"`, or `"compact"`. The `"compact"` value fires when instruction files are re-loaded after a compaction event |
| `globs` | Path glob patterns from the file's `paths:` frontmatter, if any. Present only for `path_glob_match` loads |
| `trigger_file_path` | Path to the file whose access triggered this load, for lazy loads |
| `parent_file_path` | Path to the parent instruction file that included this one, for `include` loads |

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/my-project",
  "hook_event_name": "InstructionsLoaded",
  "file_path": "/Users/my-project/CLAUDE.md",
  "memory_type": "Project",
  "load_reason": "session_start"
}
```

#### InstructionsLoaded decision control

InstructionsLoaded hooks have no decision control. They can't block or modify instruction loading. Claude Code discards their [JSON output fields](#json-output), such as `systemMessage` and `continue`. Use this event for audit logging, compliance tracking, or observability.

### UserPromptSubmit

Runs when a prompt is submitted, before Claude processes it. This allows you
to add additional context based on the prompt/conversation, validate prompts, or
block certain types of prompts.

`UserPromptSubmit` hooks don't fire only on prompts you type. Claude Code also runs them on:

* A [session-scoped scheduled task](https://code.claude.com/docs/en/scheduled-tasks.md) firing, including a `/loop` iteration
* A [background subagent](https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background) reporting back to the session that started it
* A [message another session sends](https://code.claude.com/docs/en/cross-session-messaging.md) to your main conversation

`UserPromptSubmit` hooks have a default timeout of 30 seconds for `command`, `http`, and `mcp_tool` types, shorter than the 600-second default for those types on most other events. Because this hook runs before every prompt and blocks model processing until it completes, a stuck hook stalls the session. If your hook needs more time, set the `timeout` field in the hook entry.

Apart from a command hook you run with [`async: true`](#run-hooks-in-the-background), a `UserPromptSubmit` command, HTTP, or MCP tool hook that reaches its timeout is canceled and its output, including any `additionalContext`, is discarded. The prompt still reaches Claude without that context. To block the prompt instead, set [`onFailure: "block"`](#block-the-action-when-a-hook-fails) on a command or HTTP hook. The transcript shows a notice naming the hook, the timeout that fired, and that the output was discarded.

An [Agent SDK callback hook](https://code.claude.com/docs/en/agent-sdk/hooks.md) on `UserPromptSubmit` that reaches its timeout blocks the prompt with a message naming the hook and the timeout, because a callback there can be acting as a policy gate that must not fail open. The session continues.

#### `Esc` during a prompt check

If you press `Esc` or interrupt the session while hooks are still checking a prompt, the check stops and the prompt doesn't reach Claude. Text you typed at the terminal returns to the prompt input, and the hooks check it again when you resend it.

A hook can block the prompt at the same moment you interrupt. The prompt then stays blocked: you see that hook's [block message](#what-a-blocked-prompt-leaves-behind), and the text doesn't return to the input.

#### UserPromptSubmit input

In addition to the [common input fields](#common-input-fields), UserPromptSubmit hooks receive the `prompt` field containing the submitted text. Pasted content that collapsed to a `[Pasted text #N]` placeholder arrives expanded in place. In sessions where Claude Code [marks pasted text for Claude](https://code.claude.com/docs/en/terminal-config.md#how-claude-treats-pasted-text), that expanded content sits between a `<pasted_content id="…">` line and a `</pasted_content id="…">` line, so account for those lines if your hook parses the prompt.

UserPromptSubmit hooks also receive `session_title` when the session has a custom title, with the same meaning as the [SessionStart `session_title` field](#sessionstart-input).

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Write a function to calculate the factorial of a number"
}
```

When the prompt is a [skill](https://code.claude.com/docs/en/skills.md) or custom command you typed, such as `/deploy staging`, the hook receives that line as you typed it rather than the expanded skill content. If the hook blocks the prompt, the command doesn't run, so shell commands the skill [injects with `` !`<command>` ``](https://code.claude.com/docs/en/skills#inject-dynamic-context) don't run either. To match on the command's name or arguments instead, use [UserPromptExpansion](#userpromptexpansion).

#### UserPromptSubmit decision control

`UserPromptSubmit` hooks can control whether a submitted prompt is processed and add context. All [JSON output fields](#json-output) are available.

There are two ways to add context to the conversation on exit code 0:

* **Plain text stdout**: Claude Code adds stdout it [treats as plain text](#exit-code-0) to Claude's context
* **JSON with `additionalContext`**: use the JSON format below for more control. The `additionalContext` field is added as context

Neither channel produces a visible transcript entry. Plain stdout and the `additionalContext` value are each injected as a system reminder that starts with the hook's name; Claude reads both. To confirm delivery, check the [debug log](#debug-hooks).

To block a prompt, return a JSON object with `decision` set to `"block"`:

| Field | Description |
| :- | :- |
| `decision` | `"block"` stops the prompt before it reaches Claude. Omit to allow the prompt to proceed |
| `reason` | Shown to the user when `decision` is `"block"`. Not added to context |
| `additionalContext` | String added to Claude's context alongside the submitted prompt. See [Add context for Claude](#add-context-for-claude) |
| `sessionTitle` | Sets the session title. Use to name sessions automatically based on the prompt content |
| `suppressOriginalPrompt` | If `true` when the hook blocks the prompt, leaves the prompt text out of the block message. See [What a blocked prompt leaves behind](#what-a-blocked-prompt-leaves-behind) |

A hook that blocks by exiting 2 routes the same way as `reason`: the block message shows the stderr text to the user, and it isn't added to context.

```json theme={null}
{
  "decision": "block",
  "reason": "Explanation for decision",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "My additional context here",
    "sessionTitle": "My session title",
    "suppressOriginalPrompt": true
  }
}
```

#### What a blocked prompt leaves behind

A blocked prompt never reaches Claude, but its text isn't removed everywhere. By default the block message shown to the user ends with `Original prompt:` followed by the submitted text, and Claude Code writes that message to the session's transcript file on disk. To leave the text out of the message, print JSON with `"suppressOriginalPrompt": true` inside `hookSpecificOutput`. This works whether the hook blocks with `decision: "block"` or by exiting 2.

`suppressOriginalPrompt` changes only the block message. The submitted text can still appear in local files such as the session transcript and your prompt history, so a blocking hook isn't a way to keep a secret off disk. To limit or remove those files, see [Plaintext storage](https://code.claude.com/docs/en/claude-directory.md#plaintext-storage) and [Clear local data](https://code.claude.com/docs/en/claude-directory.md#clear-local-data).

### UserPromptExpansion

Runs when a user-typed command expands into a prompt before reaching Claude. Use this to block specific commands from direct invocation, inject context for a particular skill, or log which commands users invoke. For example, a hook matching `deploy` can block `/deploy` unless an approval file is present, or a hook matching a review skill can append the team's review checklist as `additionalContext`.

This event covers the path `PreToolUse` doesn't: a `PreToolUse` hook matching the `Skill` tool fires only when Claude calls the tool, but typing `/skillname` directly bypasses `PreToolUse`. `UserPromptExpansion` fires on that direct path.

Matches on `command_name`. Leave the matcher empty to fire on every prompt-type command.

#### UserPromptExpansion input

In addition to the [common input fields](#common-input-fields), UserPromptExpansion hooks receive `expansion_type`, `command_name`, `command_args`, `command_source`, and the original `prompt` string. The `expansion_type` field is `slash_command` for skill and custom commands, or `mcp_prompt` for MCP server prompts.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../00893aaf.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "UserPromptExpansion",
  "expansion_type": "slash_command",
  "command_name": "example-skill",
  "command_args": "arg1 arg2",
  "command_source": "plugin",
  "prompt": "/example-skill arg1 arg2"
}
```

#### UserPromptExpansion decision control

`UserPromptExpansion` hooks can block the expansion or add context. All [JSON output fields](#json-output) are available.

| Field | Description |
| :- | :- |
| `decision` | `"block"` prevents the command from expanding. Omit to allow it to proceed |
| `reason` | Shown to the user when `decision` is `"block"` |
| `additionalContext` | String added to Claude's context alongside the expanded prompt. See [Add context for Claude](#add-context-for-claude) |

A hook that blocks by exiting 2 routes the same way as `reason`: the block message shows the stderr text to the user.

```json theme={null}
{
  "decision": "block",
  "reason": "This slash command is not available",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptExpansion",
    "additionalContext": "Additional context for this expansion"
  }
}
```

### MessageDisplay

Runs while an assistant message streams to the screen. Claude Code displays the message in increments: each time a batch of newly completed lines is ready to render, the hook runs once with those lines and Claude Code renders the hook's replacement text in their place. A long message produces several calls; a short message may produce only one.

Use MessageDisplay to:

* strip markdown for a minimal display
* transform the text an Agent SDK application shows its users
* redact API keys or internal hostnames from Claude's responses

Claude Code holds each batch until your hook returns, so keep the hook fast. If the hook fails or times out, Claude Code displays the original text. The default timeout for this event is 10 seconds; if your hook needs more time, set the `timeout` field in the hook entry.

MessageDisplay is display-only: the replacement text changes only what is rendered on screen. The transcript and what Claude sees keep the original text, so Claude never sees the replacement, and verbose mode shows the original. The hook receives assistant message text only, so tool results and the text you type render unchanged.

MessageDisplay doesn't support matchers and fires for every assistant message that streams text; messages with no text, such as tool-call-only responses, don't trigger it.

In non-interactive runs, including Agent SDK queries and `claude -p`, MessageDisplay runs once per assistant message instead of once per batch of lines. The single call arrives after the message completes and carries the full message text: `index` is `0`, `final` is `true`, and `delta` holds the entire message. A hook that collects the `delta` text for each message receives the same total text in both modes.

#### MessageDisplay input

In addition to the [common input fields](#common-input-fields), MessageDisplay hooks receive identifiers for the turn and message, the position of this call within the message, and the new text in `delta`. Batch boundaries depend on how the text streams, so use `index` and `final` to track progress through a message rather than expecting lines to be grouped a particular way.

| Field | Description |
| :- | :- |
| `turn_id` | UUID of the current turn |
| `message_id` | UUID of the assistant message being displayed. Stable across every batch of the same message. This is not the API `msg_…` id, so it can't be correlated with transcript message ids |
| `index` | Zero-based index of this batch within the message |
| `final` | `true` on the message's last batch. Each message has exactly one final batch |
| `delta` | The newly completed lines since the prior batch, terminating newlines included. Always whole lines, except the final batch which may end mid-line. In interactive runs, the final batch's delta is empty when the message ends on a newline, so treat `final`, not a non-empty delta, as the end-of-message signal. In Agent SDK and `claude -p` runs, the single call carries the entire message |

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/my-project",
  "hook_event_name": "MessageDisplay",
  "turn_id": "0c9e6a2f-7d41-4f4e-9a15-3f4f7c2b8d10",
  "message_id": "5b2a9c8e-1f63-4d8a-b7c4-9e0d2a6f1c3b",
  "index": 0,
  "final": false,
  "delta": "Here is the plan:\n"
}
```

#### MessageDisplay output

In addition to the [JSON output fields](#json-output) available to all hooks, MessageDisplay hooks can return `displayContent` to replace the delta on screen:

| Field | Description |
| :- | :- |
| `displayContent` | Text displayed in place of the delta. Omit it to display the original |

MessageDisplay hooks have no decision control. They can't block the message or change what is stored in the transcript or sent to Claude. Claude Code acts on `displayContent` from their JSON output and discards `systemMessage` and `continue`.

This example strips markdown formatting from Claude's responses for a plain-text display. The script reads each batch from stdin, removes bold markers and inline code backticks from `delta`, and returns the result as `displayContent`.

**macOS/Linux**

Register a command hook for the event in your settings file:

```json theme={null}
{
  "hooks": {
    "MessageDisplay": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/plain-display.sh",
            "args": []
          }
        ]
      }
    ]
  }
}
```

Save this script to `.claude/hooks/plain-display.sh` in your project and make it executable with `chmod +x`:

```bash theme={null}
#!/bin/bash
jq '{hookSpecificOutput: {hookEventName: "MessageDisplay", displayContent: (.delta | gsub("\\*\\*"; "") | gsub("`"; ""))}}'
```

**Windows (PowerShell)**

Register a command hook that runs the script through PowerShell:

```json theme={null}
{
  "hooks": {
    "MessageDisplay": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/plain-display.ps1"
            ]
          }
        ]
      }
    ]
  }
}
```

The `-NoProfile` flag skips loading your PowerShell profile so the hook starts fast, and `-ExecutionPolicy Bypass` lets PowerShell run the local script file.

Save this script to `.claude/hooks/plain-display.ps1` in your project:

```powershell theme={null}
$batch = [Console]::In.ReadToEnd() | ConvertFrom-Json
$text = $batch.delta -replace '\*\*', '' -replace '`', ''
@{
  hookSpecificOutput = @{
    hookEventName = "MessageDisplay"
    displayContent = $text
  }
} | ConvertTo-Json
```

Batches with no markdown pass through unchanged. If the script fails, for example because `jq` is missing, Claude Code displays the original text and notes the failure only in [debug output](#debug-hooks), not in the session.

### PreToolUse

Runs after Claude creates tool parameters and before processing the tool call. Matches on any tool name except `EndConversation`: built-in tools such as `Bash`, `PowerShell`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `Agent`, `Workflow`, `WebFetch`, `WebSearch`, `AskUserQuestion`, and `ExitPlanMode`, and any [MCP tool names](#match-mcp-tools).

To run a hook when a specific file changes on disk, whatever wrote it, use [FileChanged](#filechanged) instead of matching file-editing tools by name. Unlike PreToolUse, Claude Code runs FileChanged hooks after the change, and they have no decision control, so they can't block the write.

> [!WARNING]
>
> PreToolUse runs only when Claude calls a tool. By default, files you [reference with `@` in your prompt](https://code.claude.com/docs/en/common-workflows#reference-files-and-directories) are added without any tool call. Claude Code inserts their contents while building the prompt, so no PreToolUse hook fires for them, including hooks matching `Read`. PreToolUse also doesn't fire for [`EndConversation`](https://code.claude.com/docs/en/tools-reference#endconversation-tool-behavior).
>
> You can block specific paths from `@` references, or turn the insertion off:
>
> * **Block specific paths**: add a [`Read` deny rule](https://code.claude.com/docs/en/permissions#read-and-edit) for them
> * **Turn the insertion off**: set [`CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`](https://code.claude.com/docs/en/env-vars#variables) in your shell, user settings, or managed settings. Claude then gets the mentioned paths with a note to read them using its file tools. If it does, your matching PreToolUse hooks run. The variable requires Claude Code v2.1.299 or later, and Claude Code ignores it in project and local settings.

Use [PreToolUse decision control](#pretooluse-decision-control) to allow, deny, ask, or defer the tool call.

An [Agent SDK callback hook](https://code.claude.com/docs/en/agent-sdk/hooks.md#hook-timeout) on `PreToolUse` that exceeds its timeout blocks the tool call.

#### PreToolUse input

In addition to the [common input fields](#common-input-fields), PreToolUse hooks receive `tool_name`, `tool_input`, and `tool_use_id`.

For an [MCP tool](#match-mcp-tools), the input also carries `mcp_server`, an object with the server's `name` and a `source` that says where the server's definition came from. The `source` values include `plugin`, `sdk`, and configuration scopes such as `user` and `project`. [`McpServerProvenance`](https://code.claude.com/docs/en/agent-sdk/typescript#mcpserverprovenance) in the Agent SDK reference lists them all and says how to treat one you don't recognize. Base trust decisions on `source` rather than on `name` or the `mcp__<server>__` tool-name prefix. The `mcp_server` field requires Claude Code v2.1.274 or later.

For the file tools `Write`, `Edit`, and `Read`, `tool_input.file_path` is always absolute:

* Claude Code expands `~` and relative paths before hooks run, so a hook that matches on paths can't be bypassed via `~` or a relative spelling of the same path
* On Windows, the path arrives with backslash separators, even when your hook runs under Git Bash where `$PWD` looks like `/c/project`
* A comparison written with forward slashes, such as a `/src/` check, never matches a backslash path, and the tool call proceeds as if the hook had nothing to block
* Normalize separators before comparing: `FILE_PATH="${FILE_PATH//\\//}"` in Bash, or `file_path.replace("\\", "/")` in Python, then match a path segment such as `/src/` rather than anchoring with `^`, since the path is absolute

A `Write` call on Windows delivers:

```json theme={null}
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "C:\\project\\src\\index.ts",
    "content": "..."
  },
  ...
}
```

The `tool_input` fields depend on the tool:

##### Bash

Executes shell commands.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `command` | string | `"npm test"` | The shell command to execute |
| `description` | string | `"Run test suite"` | Optional description of what the command does |
| `timeout` | number | `120000` | Optional timeout in milliseconds. Values above the [maximum](https://code.claude.com/docs/en/tools-reference.md#bash-tool-behavior) are reduced to the maximum rather than rejected |
| `run_in_background` | boolean | `false` | Whether to run the command in background |

When a Bash command changes files in a Git repository, Claude Code can record what changed. It records the changes in every permission mode when the [`bashEditDiffEnabled`](https://code.claude.com/docs/en/settings-reference#basheditdiffenabled) setting turns recording on; that setting's entry says which files can set it. Otherwise it records them only in auto mode and `bypassPermissions` mode, and only when Claude Code directs Claude to edit files through Bash. Set `bashEditDiffEnabled` to `false` to turn the recording off. Background commands and read-only commands carry no diff.

Your [PostToolUse hook](#posttooluse) then receives the changed files in `tool_response.bashEditDiff`. The list covers what changed under the repository while the command ran. Files that Git ignores and files in submodules aren't listed. Requires Claude Code v2.1.269 or later.

> [!NOTE]
>
> The list is best effort and in public beta. Claude Code can miss a change, include a file that another process changed at the same time, or stop at its size limits. The field shape may change. Use the list to find what to review, not to enforce a policy.

`changedFiles` and `files` list what the command changed; the remaining fields say how complete and how reliable that list is.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `changedFiles` | array | `["/path/to/src/app.ts"]` | Absolute paths of the files the command changed, at most 200. Present whenever `files` holds a diff or `moreFiles` is above zero |
| `files` | array | `[{"filePath": "/path/to/src/app.ts", "hunks": [...]}]` | Diffs of up to 5 changed files, for display. `created` or `deleted` is `true` for a file the command added or removed |
| `moreFiles` | number | `2` | Count of changed files with no diff in `files` |
| `unavailable` | boolean | `true` | Set when the diff is incomplete or couldn't be taken |
| `skipped` | boolean | `true` | Set for a Git command that moves the working tree, such as `git checkout` or `git stash`, so Claude Code takes no diff |
| `shared` | boolean | `true` | Set when another Bash tool call, such as a subagent's, ran in the same repository at the same time, so some listed changes may be that command's |

##### PowerShell

Executes PowerShell commands. See the [PowerShell tool](https://code.claude.com/docs/en/tools-reference.md#powershell-tool) for availability by platform.

The fields match the Bash tool, with the command string in `command`:

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `command` | string | `"Get-ChildItem -Recurse"` | The PowerShell command to execute |
| `description` | string | `"List files recursively"` | Optional description of what the command does |
| `timeout` | number | `120000` | Optional timeout in milliseconds |
| `run_in_background` | boolean | `false` | Whether to run the command in background |

Match `Bash|PowerShell` in hooks that inspect shell commands, so they cover both tools:

* On Windows, wherever the PowerShell tool is enabled, Claude treats PowerShell as the primary shell and routes shell commands through it.
* On Windows without Git Bash, the tool is enabled automatically and Claude Code doesn't register the Bash tool at all.
* A hook that matches only `Bash` never fires there.

##### Write

Creates or overwrites a file.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `file_path` | string | `"/path/to/file.txt"` | Absolute path to the file to write |
| `content` | string | `"file content"` | Content to write to the file |

##### Edit

Replaces a string in an existing file.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `file_path` | string | `"/path/to/file.txt"` | Absolute path to the file to edit |
| `old_string` | string | `"original text"` | Text to find and replace |
| `new_string` | string | `"replacement text"` | Replacement text |
| `replace_all` | boolean | `false` | Whether to replace all occurrences |

##### Read

Reads file contents.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `file_path` | string | `"/path/to/file.txt"` | Absolute path to the file to read |
| `offset` | number | `10` | Optional line number to start reading from |
| `limit` | number | `50` | Optional number of lines to read |

##### Glob

Finds files matching a glob pattern.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `pattern` | string | `"**/*.ts"` | Glob pattern to match files against |
| `path` | string | `"/path/to/dir"` | Optional directory to search in. Defaults to current working directory |

##### Grep

Searches file contents with regular expressions.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `pattern` | string | `"TODO.*fix"` | Regular expression pattern to search for |
| `path` | string | `"/path/to/dir"` | Optional file or directory to search in |
| `glob` | string | `"*.ts"` | Optional glob pattern to filter files |
| `output_mode` | string | `"content"` | `"content"`, `"files_with_matches"`, or `"count"`. Defaults to `"files_with_matches"` |
| `-i` | boolean | `true` | Case insensitive search |
| `multiline` | boolean | `false` | Enable multiline matching |

##### WebFetch

Fetches and processes web content.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `url` | string | `"https://example.com/api"` | URL to fetch content from |
| `prompt` | string | `"Extract the API endpoints"` | Prompt to run on the fetched content |
| `offset` | number | `100000` | Optional number of characters to skip from the start of the page. Claude sets it to keep reading a long page. Requires Claude Code v2.1.290 or later |

##### WebSearch

Searches the web.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `query` | string | `"react hooks best practices"` | Search query |
| `allowed_domains` | array | `["docs.example.com"]` | Optional: only include results from these domains |
| `blocked_domains` | array | `["spam.example.com"]` | Optional: exclude results from these domains |

##### Agent

Spawns a [subagent](https://code.claude.com/docs/en/sub-agents.md).

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `prompt` | string | `"Find all API endpoints"` | The task for the agent to perform |
| `description` | string | `"Find API endpoints"` | Short description of the task |
| `subagent_type` | string | `"Explore"` | Type of specialized agent to use |
| `model` | string | `"sonnet"` | Optional model alias to override the default |

When a foreground Agent call completes, your [PostToolUse hook](#posttooluse) receives the subagent's result and run telemetry in `tool_response`. Read these fields to inspect the run; for token and cost rollups across subagents, use the [token and cost counters](https://code.claude.com/docs/en/monitoring-usage.md#token-counter) filtered to `query_source` `"subagent"`, since `totalTokens` and `usage` cover the final request only:

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `status` | string | `"completed"` | `"completed"` for foreground subagents, `"async_launched"` for background subagents. For which subagents run each way, see [Run subagents in foreground or background](https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background) |
| `agentId` | string | `"a4d2c8f1e0b3a297"` | Identifier for the subagent run |
| `content` | array | `[{"type": "text", "text": "Found 12 endpoints..."}]` | The subagent's final text blocks, or, for a subagent whose report goes through `SubagentHandback`, a short note about that hand-back in their place |
| `resolvedModel` | string | `"claude-sonnet-4-5"` | Model the subagent started on, which may differ from the requested model |
| `modelsUsed` | array | `["claude-sonnet-4-5", "claude-haiku-4-5"]` | Models used in order, with consecutive repeats collapsed; set only when the model was swapped mid-run |
| `totalTokens` | number | `12450` | Token count from the subagent's final API request: input, output, and cache tokens combined. This isn't a total across the whole run |
| `totalDurationMs` | number | `48211` | Wall-clock duration of the subagent run |
| `totalToolUseCount` | number | `7` | Count of tool calls the subagent made |
| `usage` | object | `{"input_tokens": 8320, ...}` | Per-type token breakdown of the final API request: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |

On Claude Code v2.1.271 or later, a subagent that runs with the [`SubagentHandback`](https://code.claude.com/docs/en/tools-reference) tool, which Claude Code provides in [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode), delivers its report through that tool rather than returning it as text. The `content` field of its `completed` result then carries a short note about that hand-back rather than the report itself. To read the report, match a `PreToolUse` or `PostToolUse` hook on `SubagentHandback` and read `tool_input.message`.

For background subagents, the tool returns when the task moves to the background, so `tool_response` carries no usage fields: a background launch returns immediately, and a foreground task that Claude Code backgrounds mid-run returns at that transition. It has `status: "async_launched"`, `agentId`, `description`, `prompt`, `outputFile`, and `resolvedModel`.

On a `completed` response, `resolvedModel` names the model the subagent started on, which can differ from the `model` value in `tool_input`, such as when `availableModels` or another override applies. On an `async_launched` response, `resolvedModel` names the model in use when the agent moved to the background, so a swap that happened before backgrounding is reflected there.

##### AskUserQuestion

Asks the user one to four multiple-choice questions.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `questions` | array | `[{"question": "Which framework?", "header": "Framework", "options": [{"label": "React", "description": "Component library"}, {"label": "Vue", "description": "Progressive framework"}], "multiSelect": false}]` | Questions to present, each with a `question` string, short `header`, `options` array, and optional `multiSelect` flag |
| `answers` | object | `{"Which framework?": "React"}` | Optional. Maps question text to the selected option label. Multi-select answers join labels with commas. Claude doesn't set this field; supply it via `updatedInput` to answer programmatically |

##### ExitPlanMode

Presents a plan and asks the user to approve it before Claude leaves [plan mode](https://code.claude.com/docs/en/permission-modes.md#analyze-before-you-edit-with-plan-mode). Claude writes the plan to a file on disk before calling the tool, so the literal `tool_input` from the model is typically empty. Claude Code injects the plan content and file path before passing the input to hooks.

| Field | Type | Example | Description |
| :- | :- | :- | :- |
| `plan` | string | `"## Refactor auth\n1. Extract..."` | Plan content in Markdown. Injected from the plan file on disk |
| `planFilePath` | string | `"/Users/.../plans/refactor-auth.md"` | Path to the plan file. Injected |
| `allowedPrompts` | array | `[{"tool": "Bash", "prompt": "run tests"}]` | Deprecated. Claude Code accepts the field but ignores it. Before v2.1.205, it carried prompt-based permissions Claude requested to implement the plan |

In `PostToolUse`, `tool_response` is an object with `plan` and `filePath` fields holding the approved plan, plus internal status flags. Read `tool_response.plan` for the plan content rather than re-reading the file from disk.

#### PreToolUse decision control

`PreToolUse` hooks can control whether a tool call proceeds. Unlike other hooks that use a top-level `decision` field, PreToolUse returns its decision inside a `hookSpecificOutput` object. This gives it richer control: four outcomes (allow, deny, ask, or defer) plus the ability to modify tool input before execution.

| Field | Description |
| :- | :- |
| `permissionDecision` | `"allow"` skips the permission prompt, except for [actions no mode auto-approves](https://code.claude.com/docs/en/permission-modes.md#actions-no-mode-auto-approves) and [reads from network paths](https://code.claude.com/docs/en/permissions.md#network-paths). It doesn't skip approval for calls to [tools an Agent SDK app marks `always_ask`](https://code.claude.com/docs/en/agent-sdk/custom-tools#require-approval-for-specific-tools) either, unless the [permission mode approves the call](https://code.claude.com/docs/en/agent-sdk/typescript.md#permission-modes-that-can-approve-an-always_ask-call). `AskUserQuestion` and `ExitPlanMode` need [`updatedInput` paired with `"allow"`](#allow-with-updatedinput). For plan mode, see [Hook approvals in plan mode](https://code.claude.com/docs/en/permissions.md#hook-approvals-in-plan-mode). `"deny"` prevents the tool call. `"ask"` prompts the user to confirm. `"defer"` ends the turn so the tool can be resumed later, and requires [non-interactive mode](#defer-a-tool-call-for-later) with the `-p` flag. [Deny and ask rules](https://code.claude.com/docs/en/permissions.md#manage-permissions) are still evaluated regardless of what the hook returns |
| `permissionDecisionReason` | For `"ask"`, shown to the user in the permission prompt. When Claude Code [denies the call](https://code.claude.com/docs/en/headless.md#turn-off-permission-prompts-in-unattended-runs) in a `-p` run where no one can answer that prompt, Claude reads the reason in the tool result instead. For `"deny"`, shown to Claude. For `"allow"` and `"defer"`, written to the [debug log](#debug-hooks) only |
| `updatedInput` | Modifies the tool's input parameters before execution. Replaces the entire input object, so include unchanged fields alongside modified ones. Claude Code evaluates permission rules and a Bash command's [auto-background eligibility](https://code.claude.com/docs/en/tools-reference.md#foreground-commands-that-move-to-the-background) against the input your hook returns, not the input Claude sent. Combine with `"allow"` to auto-approve, or `"ask"` to show the modified input to the user. For `"defer"`, ignored |
| `additionalContext` | String added to Claude's context alongside the tool result. Ignored when `permissionDecision` is `"defer"`. See [Add context for Claude](#add-context-for-claude) |

When multiple PreToolUse hooks return different decisions, precedence is `deny` > `defer` > `ask` > `allow`.

A hook that blocks by exiting 2 routes the same way as `"deny"`: Claude sees the stderr message as the denial reason.

When a hook returns `"ask"`, the permission prompt displayed to the user includes a label identifying where the hook came from: `[settings]` for a hook from any settings file or from agent frontmatter, `[plugin:<name>]` for a plugin's hook, or `[skill]` for a hook from skill frontmatter. This helps users understand which configuration source is requesting confirmation.

A hook's `"ask"` also forces a permission prompt in [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode): the classifier can still deny the tool call, but it can't approve the call silently.

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "My reason here",
    "updatedInput": {
      "field_to_modify": "new value"
    },
    "additionalContext": "Current environment: production. Proceed with caution."
  }
}
```

> [!NOTE]
>
> PreToolUse previously used top-level `decision` and `reason` fields, but these are deprecated for this event. Use `hookSpecificOutput.permissionDecision` and `hookSpecificOutput.permissionDecisionReason` instead. The deprecated values `"approve"` and `"block"` map to `"allow"` and `"deny"` respectively. Other events like PostToolUse and Stop continue to use top-level `decision` and `reason` as their current format.

#### Tools that require user interaction

`AskUserQuestion` and `ExitPlanMode` require user interaction. In [non-interactive mode](https://code.claude.com/docs/en/headless.md) with the `-p` flag, Claude Code offers them only when the run has a [permission host](https://code.claude.com/docs/en/headless.md#turn-off-permission-prompts-in-unattended-runs) to receive the prompt, such as an Agent SDK `canUseTool` callback.

A `PreToolUse` hook satisfies that requirement when it does the following:

1. Reads the tool's input from stdin
2. Collects the answer through your own UI
3. Returns `permissionDecision: "allow"` together with `updatedInput` that holds the answer, so the tool runs without prompting

Returning `"allow"` alone is not sufficient for these tools.

For `AskUserQuestion`, echo back the original `questions` array and add an [`answers`](#askuserquestion) object mapping each question's text to the chosen answer. This output answers one question with `React`:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "questions": [
        {
          "question": "Which framework?",
          "header": "Framework",
          "options": [{"label": "React", "description": "Component library"}, {"label": "Vue", "description": "Progressive framework"}],
          "multiSelect": false
        }
      ],
      "answers": {"Which framework?": "React"}
    }
  }
}
```

An MCP tool whose server marks it with [`_meta["anthropic/requiresUserInteraction"]`](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool) is stricter: a hook can't skip its approval prompt with `"allow"`, with or without `updatedInput`, because Claude Code can't confirm the hook collected the interaction the tool needs.

#### Defer a tool call for later

`"defer"` is for integrations that run `claude -p` as a subprocess and read its JSON output, such as an Agent SDK app or a custom UI built on top of Claude Code. It lets that calling process pause Claude at a tool call, collect input through its own interface, and resume where it left off. Claude Code honors this value only in [non-interactive mode](https://code.claude.com/docs/en/headless.md) with the `-p` flag. In interactive sessions it logs a warning and ignores the hook result.

The `AskUserQuestion` tool is the typical case: Claude wants to ask the user something, but there is no terminal to answer in. A `-p` run offers `AskUserQuestion` only when it has a [permission host](https://code.claude.com/docs/en/headless.md#turn-off-permission-prompts-in-unattended-runs), such as an MCP tool you pass with `--permission-prompt-tool`, so start the run with one. The round trip works like this:

1. Claude calls `AskUserQuestion`. The `PreToolUse` hook fires.
2. The hook returns `permissionDecision: "defer"`. The tool doesn't execute. The turn ends with a result carrying `stop_reason: "tool_deferred"`, and the pending tool call stays in the transcript.
3. The calling process reads `deferred_tool_use` from the SDK result, surfaces the question in its own UI, and waits for an answer.
4. The calling process runs `claude -p --resume <session-id>` with the same permission host. The same tool call fires `PreToolUse` again.
5. The hook returns `permissionDecision: "allow"` with the answer in `updatedInput`. The tool executes and Claude continues.

The `deferred_tool_use` field carries the tool's `id`, `name`, and `input`. The `input` is the parameters Claude generated for the tool call, captured before execution:

```json theme={null}
{
  "type": "result",
  "subtype": "success",
  "stop_reason": "tool_deferred",
  "session_id": "abc123",
  "deferred_tool_use": {
    "id": "toolu_01abc",
    "name": "AskUserQuestion",
    "input": { "questions": [{ "question": "Which framework?", "header": "Framework", "options": [{"label": "React", "description": "Component library"}, {"label": "Vue", "description": "Progressive framework"}], "multiSelect": false }] }
  }
}
```

There is no timeout or retry limit. The session remains on disk until you resume it, subject to the [`cleanupPeriodDays`](https://code.claude.com/docs/en/settings-reference#cleanupperioddays) retention sweep, which deletes session files after 30 days by default, following the [retention sweep rules](https://code.claude.com/docs/en/claude-directory.md#cleaned-up-automatically).

If the deferred tool is no longer available when you resume, the resume's first result has `stop_reason: "tool_deferred_unavailable"` and `is_error: true`, and the hook doesn't fire. This happens when an MCP server that provided the tool is not connected for the resumed session. The `deferred_tool_use` payload is still included so you can identify which tool went missing.

* **If you sent no prompt, with the resume or after it**, the call is still pending. Resume again with the tool available and it runs first.
* **If you sent a prompt, with the resume or after it**, Claude Code answers it without the tool's result and drops the deferred call. Send a new prompt once the tool is available if you still need it called.

If the answer you're waiting for is not ready when you resume without a prompt, the hook can return `"defer"` again. If you sent a prompt and the hook defers again, Claude Code treats the prompt the same way: it answers without the tool's result and drops the call. Resume without a prompt until the hook returns `"allow"` or `"deny"`, which is how the calling process breaks the loop.

`"defer"` only works when Claude makes a single tool call in the turn. If Claude makes several tool calls at once, `"defer"` is ignored with a warning and the tool proceeds through the normal permission flow. The constraint exists because resume can only re-run one tool: there is no way to defer one call from a batch without leaving the others unresolved.

> [!NOTE]
>
> To resume a deferred session in plan mode, pass [`--permission-prompt-tool`](https://code.claude.com/docs/en/cli-reference#cli-flags) along with `--resume` so that Claude Code can present the plan for approval. For the other conditions, see [Resume in plan mode with `-p`](https://code.claude.com/docs/en/sessions#resume-in-plan-mode-with-p). Requires Claude Code v2.1.246 or later.
>
> When you resume with `-p`, Claude Code doesn't restore any other stored permission mode. It starts the run in the permission mode a new `claude -p` run would start in, so pass `--permission-mode` or `--dangerously-skip-permissions` again if the deferred session used one. When you resume with `claude --resume <session-id>` without `-p`, Claude Code restores the stored permission mode, with the exceptions listed in [permission mode on resume](https://code.claude.com/docs/en/sessions.md#permission-mode-on-resume).

### PermissionRequest

Runs when Claude Code is about to ask you for permission to use a tool. In sessions that can't show a prompt, such as background subagents in [non-interactive mode](https://code.claude.com/docs/en/headless.md), Claude Code still runs these hooks, and if no hook returns a decision, it denies the tool call. For a call that reaches a `--permission-prompt-tool` or the Agent SDK's [`canUseTool` callback](https://code.claude.com/docs/en/agent-sdk/permissions), the hooks run alongside your host, and whichever decides first applies.
Use [PermissionRequest decision control](#permissionrequest-decision-control) to allow or deny on behalf of the user.

Use this event when you need a signal the moment Claude asks for permission to use a tool. Claude Code runs a [Notification](#notification) hook with the `permission_prompt` type only after the prompt has waited about six seconds.

Claude Code doesn't run PermissionRequest hooks for a sandboxed command's [network request](https://code.claude.com/docs/en/sandboxing.md#network-isolation). To get a signal for that prompt, use the `permission_prompt` notification type.

Matches on tool name, same values as PreToolUse.

#### PermissionRequest input

PermissionRequest hooks receive `tool_name` and `tool_input` fields like PreToolUse hooks, but without `tool_use_id`. For an MCP tool, they also receive the [`mcp_server`](#pretooluse-input) object. An optional `permission_suggestions` array contains the [permission updates](#permission-update-entries) Claude Code suggests for this request, such as adding an allow rule or changing the permission mode.

The `permission_suggestions` array isn't an exact list of the options you see, because each permission dialog builds its own options. Some dialogs, such as the one for file edits, don't read the array at all and derive their options from the request itself. A dialog that does read it can still withhold an option whose suggestion stays in the array, for example when [`allowManagedPermissionRulesOnly`](https://code.claude.com/docs/en/settings-reference#allowmanagedpermissionrulesonly) hides rule-saving options. It can also offer options that have no suggestion entry, such as [**Yes, and switch to auto mode**](https://code.claude.com/docs/en/permission-modes.md#switch-permission-modes), which changes the permission mode directly rather than through a permission update.

PreToolUse hooks run before every tool call, whether or not it needs permission. PermissionRequest hooks run only when Claude Code is about to ask you for permission, or when it would otherwise auto-deny a call that can't prompt. Neither event fires for [`EndConversation`](https://code.claude.com/docs/en/tools-reference#endconversation-tool-behavior).

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf node_modules",
    "description": "Remove node_modules directory"
  },
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "rm -rf node_modules" }],
      "behavior": "allow",
      "destination": "localSettings"
    }
  ]
}
```

#### PermissionRequest decision control

`PermissionRequest` hooks can allow or deny permission requests. In addition to the [JSON output fields](#json-output) available to all hooks, your hook script can return a `decision` object with these event-specific fields:

| Field | Description |
| :- | :- |
| `behavior` | `"allow"` grants the permission, `"deny"` denies it. [Deny and ask rules](https://code.claude.com/docs/en/permissions.md#manage-permissions) are still evaluated, so a hook returning `"allow"` doesn't override a matching deny rule |
| `updatedInput` | For `"allow"` only: modifies the tool's input parameters before execution. Replaces the entire input object, so include unchanged fields alongside modified ones. The modified input is re-evaluated against deny and ask rules |
| `updatedPermissions` | For `"allow"` only: array of [permission update entries](#permission-update-entries) to apply, such as adding an allow rule or changing the session permission mode |
| `message` | For `"deny"` only: tells Claude why the permission was denied |
| `interrupt` | For `"deny"` only: if `true`, stops Claude |

A hook that exits 2 without a `decision` object leaves the permission flow unchanged, and its stderr is discarded. To grant or deny the request, return the `decision` object.

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": {
        "command": "npm run lint"
      }
    }
  }
}
```

#### Permission update entries

The `updatedPermissions` output field and the [`permission_suggestions` input field](#permissionrequest-input) both use the same array of entry objects. Each entry has a `type` that determines its other fields, and a `destination` that controls where the change is written.

| `type` | Fields | Effect |
| :- | :- | :- |
| `addRules` | `rules`, `behavior`, `destination` | Adds permission rules. `rules` is an array of `{toolName, ruleContent?}` objects. Omit `ruleContent` to match the whole tool. `behavior` is `"allow"`, `"deny"`, or `"ask"` |
| `replaceRules` | `rules`, `behavior`, `destination` | Replaces all rules of the given `behavior` at the `destination` with the provided `rules` |
| `removeRules` | `rules`, `behavior`, `destination` | Removes matching rules of the given `behavior` |
| `setMode` | `mode`, `destination` | Changes the permission mode. Valid modes are `default`, `auto`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan`, and `manual` as an alias for `default` |
| `addDirectories` | `directories`, `destination` | Adds working directories. `directories` is an array of path strings |
| `removeDirectories` | `directories`, `destination` | Removes working directories |

> [!NOTE]
>
> `setMode` with `bypassPermissions` only takes effect if you launched the session with bypass mode already available: `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--allow-dangerously-skip-permissions`, or `permissions.defaultMode: "bypassPermissions"` in [user, `--settings`, or managed settings](https://code.claude.com/docs/en/settings-reference#permissions-defaultmode). Otherwise the update is a no-op. The update is also a no-op when [`permissions.disableBypassPermissionsMode`](https://code.claude.com/docs/en/permissions#managed-settings) disables the mode, or when the session starts in [restricted mode](https://code.claude.com/docs/en/cli-reference.md#cli-flags).
>
> `bypassPermissions` is never persisted as `defaultMode` regardless of `destination`.

The `destination` field on every entry determines whether the change stays in memory or persists to a settings file.

| `destination` | Writes to |
| :- | :- |
| `session` | in-memory only, discarded when the session ends |
| `localSettings` | `.claude/settings.local.json` |
| `projectSettings` | `.claude/settings.json` |
| `userSettings` | `~/.claude/settings.json` |

A hook can echo one of the `permission_suggestions` it received as its own `updatedPermissions` output.

### PostToolUse

Runs immediately after a tool completes successfully.

Matches on tool name, same values as PreToolUse.

Match more broadly when the tool name isn't the right filter:

* To run a hook after any tool completes successfully, omit the `matcher` or set it to `"*"`. Your hook can then discover what changed itself, for example by running `git status --porcelain`, which also lists untracked files that `git diff` misses. For tool calls that fail, add the same hook under [PostToolUseFailure](#posttoolusefailure).
* To run a hook when a specific file changes on disk, whatever wrote it, use [FileChanged](#filechanged). Claude Code doesn't run a `PostToolUse` hook matching `Edit|Write` when a `Bash` command or a process outside Claude Code rewrites the same file.

#### PostToolUse input

`PostToolUse` hooks fire after a tool has already executed successfully. The input includes both `tool_input`, the arguments sent to the tool, and `tool_response`, the result it returned. The exact schema for both depends on the tool. File-tool `tool_input` paths arrive in the same format as for [PreToolUse](#pretooluse-input): always absolute, with the platform's native separators, so backslashes on Windows. For an MCP tool, the input also carries the [`mcp_server`](#pretooluse-input) object.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  },
  "tool_response": {
    "filePath": "/path/to/file.txt",
    "type": "create"
  },
  "tool_use_id": "toolu_01ABC123...",
  "duration_ms": 12
}
```

| Field | Description |
| :- | :- |
| `duration_ms` | Optional. Tool execution time in milliseconds. Excludes time spent in permission prompts and PreToolUse hooks |

#### PostToolUse decision control

`PostToolUse` hooks can provide feedback to Claude after tool execution. In addition to the [JSON output fields](#json-output) available to all hooks, your hook script can return these event-specific fields:

| Field | Description |
| :- | :- |
| `decision` | `"block"` adds the `reason` next to the tool result. Claude still sees the original output; to replace it, use `updatedToolOutput` |
| `reason` | Explanation shown to Claude when `decision` is `"block"` |
| `additionalContext` | String added to Claude's context alongside the tool result. See [Add context for Claude](#add-context-for-claude) |
| `classifierContext` | Short note about this call's result for the [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) classifier rather than for Claude. See [Annotate a result for the auto mode classifier](#annotate-a-result-for-the-auto-mode-classifier). Requires Claude Code v2.1.236 or later |
| `updatedToolOutput` | Replaces the tool's output with the provided value before it is sent to Claude. The value must match the tool's output shape |
| `updatedMCPToolOutput` | Replaces the output for [MCP tools](#match-mcp-tools) only. Prefer `updatedToolOutput`, which works for all tools |

The example below replaces the output of a `Bash` call. The replacement value matches the `Bash` tool's output shape:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Additional information for Claude",
    "updatedToolOutput": {
      "stdout": "[redacted]",
      "stderr": "",
      "interrupted": false,
      "isImage": false
    }
  }
}
```

> [!WARNING]
>
> `updatedToolOutput` only changes what Claude sees. The tool has already run by the time the hook fires, so any files written, commands executed, or network requests sent have already taken effect. Telemetry such as OpenTelemetry tool spans and analytics events also captures the original output before the hook runs. To prevent or modify a tool call before it runs, use a [PreToolUse](#pretooluse) hook instead.
>
> The replacement value must match the tool's output shape. Built-in tools return structured objects rather than plain strings. For example, `Bash` returns an object with `stdout`, `stderr`, `interrupted`, and `isImage` fields. For built-in tools, a value that doesn't match the tool's output schema is ignored and the original output is used. MCP tool output is passed through without schema validation. Stripping error details that Claude needs can cause it to proceed on a false assumption.

#### Annotate a result for the auto mode classifier

Return `classifierContext` to send a short note about the tool call's result to the [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) classifier rather than to Claude. The classifier [never receives tool results themselves](https://code.claude.com/docs/en/permission-modes.md#how-the-classifier-evaluates-actions), so this field is the supported way to tell it something about what a call returned before it reviews later actions. The field requires Claude Code v2.1.236 or later.

The example below tells the classifier where a query's output came from:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "classifierContext": "This query ran against the staging database, not production."
  }
}
```

How much weight the classifier gives the note depends on where you configured the hook:

* **Hooks configured in Claude Code**: for hooks from settings files, plugins, skills, and agent frontmatter, the classifier treats the note as unverified, application-provided context. The note never establishes user intent, and if it claims you approved or requested something, the classifier checks that claim against your own messages in the conversation
* **In-process Agent SDK callbacks**: when an application embedding Claude Code registers the hook as a [TypeScript SDK callback](https://code.claude.com/docs/en/agent-sdk/hooks.md) and returns the note during the live session, the classifier may weigh a user statement relayed in the note as user intent. Such a statement can satisfy a consent requirement the classifier would accept from a message you send, but it never lifts a block that your own message couldn't lift either. After a session resumes, Claude Code treats restored notes as unverified context. When hooks from both groups annotate the same call, the classifier treats the combined note as unverified

Claude Code applies these limits when delivering the note:

* **Length**: Claude Code caps the notes for one tool call at 2,000 characters and truncates the rest. The cap is shared across every hook that responds to that call
* **Synchronous responses only**: Claude Code ignores the field in the response of a hook that [runs in the background](#run-hooks-in-the-background), because that response arrives after Claude Code records the tool result
* **Calls that the classifier doesn't record**: the classifier's transcript omits read-only lookups such as file reads and searches. Claude Code discards a note attached to one of those calls
* **Interaction with rewrites**: when the note describes output you're replacing with `updatedToolOutput`, return both fields in the same hook response. Claude Code drops the note if that rewrite is rejected or another hook's rewrite replaces it. Claude Code delivers a note you return without a rewrite even when another hook rewrites the output

> [!WARNING]
>
> The classifier reads content you place in `classifierContext` as information from the application hosting the session, so don't copy untrusted tool output or third-party text into it. Keep the note to a short assertion about this one call, such as a fact about its origin or a user statement about it; don't use the field to deliver unrelated messages or a stream of events.

### PostToolUseFailure

Runs when a tool that started executing fails: the tool threw an error, or an MCP tool returned an error result. Use this to log failures, send alerts, or provide corrective feedback to Claude.

Matches on tool name, same values as PreToolUse.

> [!NOTE]
>
> This event doesn't fire for tool calls rejected before execution: an unknown tool name, input that fails schema or tool-specific validation, or a permission denial. Validation rejections are returned as `tool_use_error` results and happen before hooks run, so they fire neither `PreToolUse` nor `PostToolUseFailure`. Permission denials fire `PreToolUse` but not this event; see [PermissionDenied](#permissiondenied).

#### PostToolUseFailure input

PostToolUseFailure hooks receive the same `tool_name` and `tool_input` fields as PostToolUse, along with error information as top-level fields. For an MCP tool, they also receive the [`mcp_server`](#pretooluse-input) object. For example, a failed `npm test` command might deliver:

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run test suite"
  },
  "tool_use_id": "toolu_01ABC123...",
  "error": "Exit code 1\nError: Cannot find module 'express'",
  "is_interrupt": false,
  "duration_ms": 4187
}
```

| Field | Description |
| :- | :- |
| `error` | String describing what went wrong. The format depends on the tool that failed |
| `is_interrupt` | Optional boolean. True when the failure reached Claude Code as an abort rather than as an error the tool reported. Cancelling a running tool does not fire this hook; the tool result carries the interruption message instead |
| `duration_ms` | Optional. Tool execution time in milliseconds. Excludes time spent in permission prompts and PreToolUse hooks |

The `error` string is generally the same text Claude receives as the failed tool's result. Its format varies by tool and failure. Key your hook on `tool_name`, `is_interrupt`, and the `Exit code N` first line; treat the rest of the string as display text, not a stable format.

* For Bash and PowerShell, a command that ran and exited produces a first line `Exit code N`, then any output the command produced as one block with stdout and stderr interleaved
* A payload may also carry a bare failure message with no exit-code line, when Claude Code could not start the shell process itself
* Claude Code middle-truncates long strings around a `... [N characters truncated] ...` marker, and can insert lines of its own, such as `Command timed out after 2m 0s`

#### PostToolUseFailure decision control

`PostToolUseFailure` hooks can provide context to Claude after a tool failure. In addition to the [JSON output fields](#json-output) available to all hooks, your hook script can return these event-specific fields:

| Field | Description |
| :- | :- |
| `additionalContext` | String added to Claude's context alongside the error. See [Add context for Claude](#add-context-for-claude) |

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUseFailure",
    "additionalContext": "Additional information about the failure for Claude"
  }
}
```

### PostToolBatch

Runs once after every tool call in a batch has resolved, before Claude Code sends the next request to the model. `PostToolUse` fires once per tool, which means it fires concurrently when Claude makes parallel tool calls. `PostToolBatch` fires exactly once with the full batch, so it is the right place to inject context that depends on the set of tools that ran rather than on any single tool. There is no matcher for this event.

#### PostToolBatch input

In addition to the [common input fields](#common-input-fields), PostToolBatch hooks receive `tool_calls`, an array describing every tool call in the batch:

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PostToolBatch",
  "tool_calls": [
    {
      "tool_name": "Read",
      "tool_input": {"file_path": "/.../ledger/accounts.py"},
      "tool_use_id": "toolu_01...",
      "tool_response": "1\tfrom __future__ import annotations\n2\t..."
    },
    {
      "tool_name": "Read",
      "tool_input": {"file_path": "/.../ledger/transactions.py"},
      "tool_use_id": "toolu_02...",
      "tool_response": "1\tfrom __future__ import annotations\n2\t..."
    }
  ]
}
```

`tool_response` contains the same content the model receives in the corresponding `tool_result` block. The value is a serialized string or content-block array, exactly as the tool emitted it. For `Read`, that means line-number-prefixed text rather than raw file contents. Responses can be large, so parse only the fields you need.

> [!NOTE]
>
> The `tool_response` shape differs from `PostToolUse`'s. `PostToolUse` passes the tool's structured `Output` object, such as `{filePath: "...", type: "create"}` for `Write`; `PostToolBatch` passes the serialized `tool_result` content the model sees.

#### PostToolBatch decision control

`PostToolBatch` hooks can inject context for Claude. In addition to the [JSON output fields](#json-output) available to all hooks, your hook script can return these event-specific fields:

| Field | Description |
| :- | :- |
| `additionalContext` | Context string injected once before the next model call. See [Add context for Claude](#add-context-for-claude) for delivery details, what to put in it, and how resumed sessions handle past values |

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolBatch",
    "additionalContext": "These files are part of the ledger module. Run pytest before marking the task complete."
  }
}
```

Returning `decision: "block"` or `continue: false` stops the agentic loop before the next model call. The blocking message comes from the JSON `reason` or `stopReason`, or from stderr on exit 2. You see it as a warning in the transcript, and it stays in the conversation, so Claude sees it when the conversation continues.

### PermissionDenied

Runs when [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) denies a tool call, including when it denies without a classifier verdict because [a safety check separate from auto mode refused the classifier's own request](https://code.claude.com/docs/en/errors.md#auto-mode-cannot-determine-the-safety-of-an-action) or its response didn't parse. This hook only fires in auto mode: it doesn't run when you manually deny a permission dialog, when a `PreToolUse` hook blocks a call, or when a `deny` rule matches. Use it to log denials, adjust configuration, or tell the model it may retry the tool call.

Matches on tool name, same values as PreToolUse.

#### PermissionDenied input

In addition to the [common input fields](#common-input-fields), PermissionDenied hooks receive `tool_name`, `tool_input`, `tool_use_id`, and `reason`. For an MCP tool, they also receive the [`mcp_server`](#pretooluse-input) object.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "auto",
  "hook_event_name": "PermissionDenied",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf /tmp/build",
    "description": "Clean build directory"
  },
  "tool_use_id": "toolu_01ABC123...",
  "reason": "[Irreversible Local Destruction]"
}
```

| Field | Description |
| :- | :- |
| `reason` | The denial reason. For a classifier verdict, in most sessions it names the matched rule in square brackets, such as `[Data Exfiltration]`; see [Review denials](https://code.claude.com/docs/en/auto-mode-config.md#review-denials) for the other forms. For a [no-verdict denial](#permissiondenied-decision-control), it starts with `Auto mode could not evaluate this action and is blocking it for safety`. For a denial because the classifier model was unavailable, it is the fixed text `Classifier unavailable` |

#### PermissionDenied decision control

PermissionDenied hooks can tell the model it may retry the denied tool call. Return a JSON object with `hookSpecificOutput.retry` set to `true`:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionDenied",
    "retry": true
  }
}
```

When `retry` is `true`, Claude Code adds a message to the conversation telling the model it may retry the tool call. Claude Code doesn't reverse the denial itself. If your hook doesn't return JSON, or returns `retry: false`, the denial stands and the model receives the original rejection message.

Claude Code ignores `retry: true` when the classifier produced [no verdict on the action](https://code.claude.com/docs/en/errors.md#auto-mode-cannot-determine-the-safety-of-an-action): its response didn't parse, or a safety check separate from auto mode refused the classifier's own request. For those denials, Claude Code already tells the model in the rejection message whether to retry later or move on.

### Notification

Runs when Claude Code sends notifications. Matches on notification type. Omit the matcher to run hooks for all notification types.

You receive these hook events even with desktop notifications turned off: the `preferredNotifChannel` setting, including `notifications_disabled`, changes only how you're alerted, not whether your hook runs.

| Matcher | When it fires |
| :- | :- |
| `permission_prompt` | Claude needs you to approve a tool use or a sandboxed command's [network request](https://code.claude.com/docs/en/sandboxing.md#network-isolation), and the prompt has waited about six seconds |
| `idle_prompt` | Claude finished responding about 60 seconds ago and you haven't typed since |
| `auth_success` | Authentication completes |
| `elicitation_dialog` | An MCP server opens an elicitation form and you haven't typed for about six seconds |
| `elicitation_url_dialog` | An MCP server asks you to open a browser URL and you haven't typed for about six seconds |
| `elicitation_complete` | An MCP server reports that a [URL-mode elicitation](#elicitation-input) is complete |
| `elicitation_response` | An MCP elicitation response is sent back to the server |
| `agent_needs_input` | A background session starts waiting on your input while [agent view](https://code.claude.com/docs/en/agent-view.md) is open in a terminal. Also fires when a terminal session shows you an [agent team teammate's terminal setup question](https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode) or auto mode's notice about [classifier request charges](https://code.claude.com/docs/en/auto-mode-classifier-billing.md) and you haven't typed for about six seconds |
| `agent_completed` | A background session finishes or fails. Fires only while [agent view](https://code.claude.com/docs/en/agent-view.md) is open in a terminal |
| `quota_auto_resume_fired` | Claude Code continues your task after a claude.ai usage limit paused it: at the reset, or sooner when something you do in Claude Code during the wait, such as adding usage credits, upgrading your plan, or switching models, makes usage available again, with the [model-setting exception](https://code.claude.com/docs/en/interactive-mode.md#wait-for-a-usage-limit-to-reset) |
| `quota_auto_resume_stale` | A claude.ai usage limit reset while your computer slept for more than about 30 minutes. Claude Code waits for you to press `Enter` instead of continuing. After a shorter sleep it continues and fires `quota_auto_resume_fired` instead |
| `quota_auto_resume_disabled` | Claude Code ends its wait for a claude.ai usage limit without continuing your task: [`autoContinueAtUsageLimit`](https://code.claude.com/docs/en/settings-reference#autocontinueatusagelimit) turned off or the reset moved more than 24 hours away during a wait Claude Code started on its own, the continued task kept hitting the limit, or the continuation was blocked before it reached the model. Doesn't fire when you press `Esc` or `Ctrl+C`, or pick **Don't continue automatically** |
| `plugin_notification` | A [mod](https://code.claude.com/docs/en/plugins/mods/api.md#show-something-without-starting-a-turn) raises a notification with `$.ui.notify`. The hook's `title` is the mod's name unless the mod set one |

The `quota_auto_resume_fired`, `quota_auto_resume_stale`, and `quota_auto_resume_disabled` types require Claude Code v2.1.234 or later.

In terminal sessions, `permission_prompt` for a sandboxed command's network request requires Claude Code v2.1.246 or later.

`agent_needs_input` for a teammate's terminal setup question requires Claude Code v2.1.248 or later.

> [!NOTE]
>
> The `permission_prompt`, `idle_prompt`, `elicitation_dialog`, and `elicitation_url_dialog` types share their timing with desktop notifications, so in terminal sessions you only see them when you appear to be away from the terminal:
>
> * Expect `permission_prompt` once you haven't typed for about six seconds. The timer starts when the permission prompt appears, and each keystroke defers it. To run a hook immediately when Claude asks for permission to use a tool, use [PermissionRequest](#permissionrequest) instead.
> * Expect `idle_prompt` about 60 seconds after Claude finishes responding, and only if you haven't typed since and no background agent, such as a background [subagent](https://code.claude.com/docs/en/sub-agents.md), is still running. Claude Code doesn't send `idle_prompt` while it waits for a claude.ai usage limit to reset. When the wait ends on its own, one of the `quota_auto_resume_*` types fires instead.
> * Expect `elicitation_dialog` for an elicitation form, or `elicitation_url_dialog` for a browser URL request, once you haven't typed for about six seconds. Both share the same six-second gate as `permission_prompt`: the timer starts when the dialog appears, and each keystroke defers it.
>
> A permission request or elicitation that arrives while another dialog is on screen keeps the same six-second gate, timed from when the request arrives. Its notification can reach you while the request still waits behind the open dialog.

Claude Code times `permission_prompt` differently in sessions where it sends permission requests to the Agent SDK's [`canUseTool` callback](https://code.claude.com/docs/en/agent-sdk/user-input), which is how Claude Desktop and the VS Code extension host Claude Code:

* Expect `permission_prompt` about six seconds after Claude asks for permission. Claude Code doesn't defer it while you type.
* If you or a [PermissionRequest](#permissionrequest) hook answer sooner, Claude Code doesn't run `permission_prompt`.
* Set [`CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS`](https://code.claude.com/docs/en/env-vars) to `1` to turn `permission_prompt` off in these sessions.

Before v2.1.233, `permission_prompt` didn't fire in these sessions.

Use separate matchers to run different handlers depending on the notification type. This configuration triggers a permission-specific alert script when Claude needs permission approval and a different notification when Claude has been idle:

```json theme={null}
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/permission-alert.sh"
          }
        ]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/idle-notification.sh"
          }
        ]
      }
    ]
  }
}
```

#### Notification input

In addition to the [common input fields](#common-input-fields), Notification hooks receive `message` with the notification text, an optional `title`, and `notification_type` indicating which type fired.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "Notification",
  "message": "Claude needs your permission",
  "title": "Permission needed",
  "notification_type": "permission_prompt"
}
```

Notification hooks can't block or modify notifications. Claude Code discards their `systemMessage` and `continue` fields but still emits [`terminalSequence`](#emit-terminal-notifications), which is what the desktop notification example relies on. Notification hooks are intended for side effects such as forwarding the notification to an external service.

### SubagentStart

Runs when Claude spawns a subagent with the Agent tool, when Claude [resumes a subagent](https://code.claude.com/docs/en/sub-agents.md#resume-subagents), and each time an in-process [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate handles a new message. Supports matchers to filter by agent type name. For built-in agents, this is the agent name like `general-purpose`, `Explore`, or `Plan`. For [custom subagents](https://code.claude.com/docs/en/sub-agents.md), this is the `name` field from the agent's frontmatter, not the filename.

For subagents shipped by a [plugin](https://code.claude.com/docs/en/plugins/overview.md), the agent type is the plugin-scoped identifier such as `my-plugin:reviewer`, not the bare frontmatter name. The colon places a plugin-scoped name on the regular-expression path, so anchor the matcher with `^` and `$` for an exact match: `^my-plugin:reviewer$`.

#### SubagentStart input

In addition to the [common input fields](#common-input-fields), SubagentStart hooks receive `agent_id` with the unique identifier for the subagent and `agent_type` with the agent name that the matcher filters on.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SubagentStart",
  "agent_id": "agent-abc123",
  "agent_type": "Explore"
}
```

SubagentStart hooks can't block subagent creation, but they can inject context into the subagent. In addition to the [JSON output fields](#json-output) available to all hooks, you can return:

| Field | Description |
| :- | :- |
| `additionalContext` | String added to the subagent's context at the start of its conversation, before its first prompt. See [Add context for Claude](#add-context-for-claude) |

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": "Follow security guidelines for this task"
  }
}
```

When the hook runs again for the same subagent, Claude Code injects the returned context only when the subagent's context doesn't already hold the copy from an earlier run. The copy injected at launch stays in place, leaving the subagent's [prompt cache](https://code.claude.com/docs/en/prompt-caching.md#subagents-and-the-cache) intact. After [auto-compaction](https://code.claude.com/docs/en/sub-agents.md#auto-compaction) discards that copy, Claude Code injects the next run's context again.

### SubagentStop

Runs when a Claude Code subagent has finished responding. Matches on agent type, same values as SubagentStart.

#### SubagentStop input

In addition to the [common input fields](#common-input-fields), SubagentStop hooks receive `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, and `last_assistant_message`. The `agent_type` field is the value used for matcher filtering. The `transcript_path` is the main session's transcript, while `agent_transcript_path` is the subagent's own transcript stored in a nested `subagents/` folder. The `last_assistant_message` field contains the text content of the subagent's final response, so hooks can access it without parsing the transcript file.

Not every SubagentStop event comes from a subagent Claude spawned. Claude Code also runs internal agents for some of its own features, such as [prompt suggestions](https://code.claude.com/docs/en/interactive-mode.md#prompt-suggestions) and [`/btw` side questions](https://code.claude.com/docs/en/interactive-mode#side-questions-with-%2Fbtw), and SubagentStop fires when one of those finishes too. For those events, `agent_type` is the agent name the session itself runs as, such as one set with [`--agent`](https://code.claude.com/docs/en/cli-reference#cli-flags) or the [`agent` setting](https://code.claude.com/docs/en/settings-reference#agent), and an empty string when the session runs without one.

A `matcher` that names agent types doesn't match an empty `agent_type`. A hook whose matcher is omitted, `""`, or `"*"`, or is a regular expression that matches an empty string, runs for events with an empty `agent_type` too.

On Claude Code v2.1.271 or later, a subagent that runs with the [`SubagentHandback`](https://code.claude.com/docs/en/tools-reference) tool delivers its report through that tool before it stops. The `last_assistant_message` field then holds the subagent's closing text, if any, which is not the delivered report. The report is that call's `message` input, which a `PreToolUse` or `PostToolUse` hook matched on `SubagentHandback` receives as `tool_input.message`.

SubagentStop hooks also receive the `background_tasks` and `session_crons` arrays described under [Stop input](#stop-input). Both arrays are scoped to the parent session, not the subagent.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../abc123.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "SubagentStop",
  "stop_hook_active": false,
  "agent_id": "def456",
  "agent_type": "Explore",
  "agent_transcript_path": "~/.claude/projects/.../abc123/subagents/agent-def456.jsonl",
  "last_assistant_message": "Analysis complete. Found 3 potential issues...",
  "background_tasks": [],
  "session_crons": []
}
```

SubagentStop hooks use the same decision control format as [Stop hooks](#stop-decision-control), including `hookSpecificOutput.additionalContext` with `hookEventName` set to `"SubagentStop"`, for non-error feedback that keeps the subagent running. Returning `decision: "block"` with a `reason` keeps the subagent running and delivers `reason` to the subagent as its next instruction. A hook that blocks by exiting 2 delivers its stderr message the same way. To inject context into the parent session after a subagent returns, use a [`PostToolUse`](#posttooluse) hook on the `Agent` tool instead.

### TaskCreated

Runs when a task is being created via the `TaskCreate` tool. Use this to enforce naming conventions, require task descriptions, or prevent certain tasks from being created. In a [session without the Task tools](https://code.claude.com/docs/en/tools-reference.md#task-tool-availability), this event doesn't fire.

TaskCreated hooks don't support matchers and fire on every occurrence.

#### TaskCreated input

In addition to the [common input fields](#common-input-fields), TaskCreated hooks receive `task_id`, `task_subject`, and optionally `task_description`, `teammate_name`, and `team_name`.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "TaskCreated",
  "task_id": "task-001",
  "task_subject": "Implement user authentication",
  "task_description": "Add login and signup endpoints",
  "teammate_name": "implementer",
  "team_name": "session-a1b2c3d4"
}
```

| Field | Description |
| :- | :- |
| `task_id` | Identifier of the task being created |
| `task_subject` | Title of the task |
| `task_description` | Detailed description of the task. May be absent |
| `teammate_name` | Name of the teammate creating the task. May be absent |
| `team_name` | Deprecated. Session-derived team name; will be removed in a future release |
| `agent_id` | On this event, the [common input field](#common-input-fields) identifies the subagent or [in-process teammate](https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode) creating the task. May be absent. Requires Claude Code v2.1.290 or later |

#### TaskCreated decision control

A TaskCreated hook can block the creation with exit code 2 or with a JSON decision. Either way, Claude Code deletes the task and returns your message to Claude as the tool's error. Claude Code ignores `continue: false` from this event and Claude keeps working.

* **Exit code 2**: Claude Code returns the stderr text as the message.
* **JSON `{"decision": "block", "reason": "..."}`**: Claude Code returns `reason` as the message.

This example blocks tasks whose subjects don't follow the required format:

```bash theme={null}
#!/bin/bash
INPUT=$(cat)
TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject')

if [[ ! "$TASK_SUBJECT" =~ ^\[TICKET-[0-9]+\] ]]; then
  echo "Task subject must start with a ticket number, e.g. '[TICKET-123] Add feature'" >&2
  exit 2
fi

exit 0
```

### TaskCompleted

Runs when a task is being marked as completed. This fires in two situations: when any agent explicitly marks a task as completed through the TaskUpdate tool, or when an [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate finishes its turn with in-progress tasks. Use this to enforce completion criteria like passing tests or lint checks before a task can close.

TaskCompleted hooks don't support matchers and fire on every occurrence.

#### TaskCompleted input

In addition to the [common input fields](#common-input-fields), TaskCompleted hooks receive `task_id`, `task_subject`, and optionally `task_description`, `teammate_name`, and `team_name`.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "TaskCompleted",
  "task_id": "task-001",
  "task_subject": "Implement user authentication",
  "task_description": "Add login and signup endpoints",
  "teammate_name": "implementer",
  "team_name": "session-a1b2c3d4"
}
```

| Field | Description |
| :- | :- |
| `task_id` | Identifier of the task being completed |
| `task_subject` | Title of the task |
| `task_description` | Detailed description of the task. May be absent |
| `teammate_name` | Name of the teammate completing the task. May be absent |
| `team_name` | Deprecated. Session-derived team name; will be removed in a future release |
| `agent_id` | On this event, the [common input field](#common-input-fields) identifies the subagent or [in-process teammate](https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode) completing the task. May be absent. Requires Claude Code v2.1.290 or later |

#### TaskCompleted decision control

TaskCompleted hooks support two ways to control task completion:

* **Exit code 2**: the task is not marked as completed and the stderr message is fed back to the model as feedback.
* **JSON `{"continue": false, "stopReason": "..."}`**: when a teammate finishing its turn triggered the event, stops the teammate entirely, matching `Stop` hook behavior. The `stopReason` is shown to the user. When the `TaskUpdate` tool triggered the event, Claude Code ignores `continue: false`; exit code 2 still blocks the completion.

This example runs tests and blocks task completion if they fail:

```bash theme={null}
#!/bin/bash
INPUT=$(cat)
TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject')

# Run the test suite
if ! npm test 2>&1; then
  echo "Tests not passing. Fix failing tests before completing: $TASK_SUBJECT" >&2
  exit 2
fi

exit 0
```

### Stop

Runs when the main Claude Code agent has finished responding. Does not run if
the stoppage occurred due to a user interrupt. API errors fire
[StopFailure](#stopfailure) instead.

> [!TIP]
>
> The [`/goal`](https://code.claude.com/docs/en/goal) command is a built-in shortcut for a session-scoped prompt-based Stop hook. Use it when you want Claude to keep working toward a condition without writing hook configuration.

#### Stop input

In addition to the [common input fields](#common-input-fields), Stop hooks receive `stop_hook_active`, `last_assistant_message`, `background_tasks`, and `session_crons`. The `stop_hook_active` field is `true` when Claude Code is already continuing as a result of a stop hook. Check this value or process the transcript to avoid blocking on a condition that will never resolve.

Claude Code applies an 8-consecutive-continuation cap: after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block and ends the turn. The count of consecutive continuations resets each time Claude calls a tool. To raise the cap, set [`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`](https://code.claude.com/docs/en/env-vars).

The `last_assistant_message` field contains the text content of Claude's final response, so hooks can access it without parsing the transcript file. For hooks that act on the just-completed turn, such as read-aloud or notification hooks, use this field rather than reading `transcript_path`: the transcript file isn't guaranteed to include the final message at Stop time on all versions.

The `background_tasks` and `session_crons` arrays let hooks distinguish "session is done" from "session is paused waiting for background work to wake it back up". Both arrays are present when the task registry is reachable and are empty when nothing is in flight or scheduled.

Each entry in `background_tasks` describes one in-flight task and uses these fields:

| Field | Description |
| :- | :- |
| `id` | Task identifier |
| `type` | Friendly task-type label such as `shell`, `subagent`, `monitor`, `workflow`, `teammate`, `cloud session`, or `MCP task`. Each label identifies which Claude Code feature created the task. Falls back to the raw discriminant for unrecognized types |
| `status` | Current task status |
| `description` | Free-text description, capped at 1000 characters with an in-string `… [+N chars]` marker when clipped |
| `command` | Shell command line, capped at 1000 characters. Present only for `shell` tasks |
| `agent_type` | Subagent type name. Present only for `subagent` tasks |
| `server` | MCP server name. Present only for `monitor` and `MCP task` tasks |
| `tool` | MCP tool name. Present only for `monitor` and `MCP task` tasks |
| `name` | Workflow name. Present only for `workflow` tasks |

Each entry in `session_crons` describes one session-scoped scheduled wakeup, sourced from `CronCreate`, `ScheduleWakeup`, and `/loop`:

| Field | Description |
| :- | :- |
| `id` | Cron task identifier |
| `schedule` | Cron expression, for example `0 9 * * 1-5` |
| `recurring` | `false` for one-shot wakeups whose schedule encodes a single fire time, `true` for tasks that re-fire on every match |
| `prompt` | Prompt submitted when the cron fires, capped at 1000 characters with the same `… [+N chars]` marker |

This example shows a Stop input with one in-flight shell task and one recurring cron:

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": true,
  "last_assistant_message": "I've completed the refactoring. Here's a summary...",
  "background_tasks": [
    {
      "id": "task-001",
      "type": "shell",
      "status": "running",
      "description": "tail logs",
      "command": "tail -f /var/log/syslog"
    }
  ],
  "session_crons": [
    {
      "id": "cron-001",
      "schedule": "0 9 * * 1-5",
      "recurring": true,
      "prompt": "check the build"
    }
  ]
}
```

#### Stop decision control

`Stop` and `SubagentStop` hooks can control whether Claude continues. In addition to the [JSON output fields](#json-output) available to all hooks, your hook script can return these event-specific fields:

| Field | Description |
| :- | :- |
| `decision` | `"block"` prevents Claude from stopping. Omit to allow Claude to stop |
| `reason` | Required when `decision` is `"block"`. Tells Claude why it should continue |
| `hookSpecificOutput.additionalContext` | Non-error feedback for Claude. The conversation continues so Claude can act on it, but unlike `decision: "block"` it is shown in the transcript as hook feedback rather than a hook error |

A hook that blocks by exiting 2 routes the same way as `reason`: Claude receives the stderr message as the explanation for why it should continue.

```json theme={null}
{
  "decision": "block",
  "reason": "Must be provided when Claude is blocked from stopping"
}
```

Use `additionalContext` when the hook is working as designed and giving Claude guidance, such as "run the test suite before finishing". It keeps the conversation going through the same loop protections as `decision: "block"`, namely the `stop_hook_active` input and the 8-consecutive-continuation cap, but the transcript labels it `Stop hook feedback` and no hook error notification is shown:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "Please run the test suite before finishing"
  }
}
```

### StopFailure

Runs instead of [Stop](#stop) when the turn ends due to an API error. Claude Code ignores the hook's output and exit code, apart from [`terminalSequence`](#emit-terminal-notifications). Use this to log failures, send alerts, or take recovery actions when Claude can't complete a response due to rate limits, authentication problems, or other API errors.

#### StopFailure input

In addition to the [common input fields](#common-input-fields), StopFailure hooks receive `error`, optional `error_details`, and optional `last_assistant_message`. The `error` field identifies the error type and is used for matcher filtering.

| Field | Description |
| :- | :- |
| `error` | Error type: `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, or `unknown` |
| `error_details` | Additional details about the error, when available |
| `last_assistant_message` | The rendered error text shown in the conversation. Unlike `Stop` and `SubagentStop`, where this field holds Claude's conversational output, for `StopFailure` it contains the API error string itself, such as `"API Error: Rate limit reached"` |

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "StopFailure",
  "error": "rate_limit",
  "error_details": "429 Too Many Requests",
  "last_assistant_message": "API Error: Rate limit reached"
}
```

StopFailure hooks have no decision control. They run for notification and logging purposes only.

### TeammateIdle

Runs when an [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate is about to go idle after finishing its turn. Use this to enforce quality gates before a teammate stops working, such as requiring passing lint checks or verifying that output files exist.

TeammateIdle hooks don't support matchers and fire on every occurrence.

#### TeammateIdle input

In addition to the [common input fields](#common-input-fields), TeammateIdle hooks receive `teammate_name` and `team_name`.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "TeammateIdle",
  "teammate_name": "researcher",
  "team_name": "session-a1b2c3d4"
}
```

| Field | Description |
| :- | :- |
| `teammate_name` | Name of the teammate that is about to go idle |
| `team_name` | Deprecated. Session-derived team name; will be removed in a future release |
| `agent_id` | On this event, the [common input field](#common-input-fields) identifies the [in-process teammate](https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode) that is about to go idle. May be absent. Requires Claude Code v2.1.290 or later |

#### TeammateIdle decision control

TeammateIdle hooks support two ways to control teammate behavior:

* **Exit code 2**: the teammate receives the stderr message as feedback and continues working instead of going idle.
* **JSON `{"continue": false, "stopReason": "..."}`**: stops the teammate entirely, matching `Stop` hook behavior. The `stopReason` is shown to the user.

This example checks that a build artifact exists before allowing a teammate to go idle:

```bash theme={null}
#!/bin/bash

if [ ! -f "./dist/output.js" ]; then
  echo "Build artifact missing. Run the build before stopping." >&2
  exit 2
fi

exit 0
```

### ConfigChange

Runs when a configuration file changes during a session. Use this to audit settings changes, enforce security policies, or block unauthorized modifications to configuration files.

Claude Code runs ConfigChange hooks when a settings file, a managed policy file, or a skill file changes. For managed policy, it runs them only when `managed-settings.json` or a file in `managed-settings.d/` changes. It applies [server-managed settings](https://code.claude.com/docs/en/server-managed-settings.md) and changes to macOS managed preferences or Windows registry policy without running them. On WSL with [`wslInheritsWindowsSettings`](https://code.claude.com/docs/en/settings-reference#wslinheritswindowssettings), it also applies a changed Windows-side managed settings file on its policy poll without running them.

The matcher filters on the configuration source:

| Matcher | When it fires |
| :- | :- |
| `user_settings` | `~/.claude/settings.json` changes |
| `project_settings` | `.claude/settings.json` changes |
| `local_settings` | `.claude/settings.local.json` changes |
| `policy_settings` | `managed-settings.json` or a file in `managed-settings.d/` changes |
| `skills` | A skill file in `.claude/skills/` changes |

This example logs all configuration changes for security auditing:

```json theme={null}
{
  "hooks": {
    "ConfigChange": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/audit-config-change.sh",
            "args": []
          }
        ]
      }
    ]
  }
}
```

#### ConfigChange input

In addition to the [common input fields](#common-input-fields), ConfigChange hooks receive `source` and optionally `file_path`. The `source` field indicates which configuration type changed, and `file_path` provides the path to the specific file that was modified.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "ConfigChange",
  "source": "project_settings",
  "file_path": "/Users/.../my-project/.claude/settings.json"
}
```

#### ConfigChange decision control

ConfigChange hooks can block configuration changes from taking effect. Use exit code 2 or a JSON `decision` to prevent the change. When blocked, the new settings are not applied to the running session.

| Field | Description |
| :- | :- |
| `decision` | `"block"` prevents the configuration change from being applied. Omit to allow the change |
| `reason` | Accepted but never shown |

```json theme={null}
{
  "decision": "block",
  "reason": "Configuration changes to project settings require admin approval"
}
```

`policy_settings` changes can't be blocked. Hooks still fire for `policy_settings` sources when a managed settings file on the machine changes, so you can use them to log those edits, but any blocking decision is ignored. This ensures enterprise-managed settings always take effect. Claude Code doesn't run `ConfigChange` hooks when [server-managed settings](https://code.claude.com/docs/en/server-managed-settings.md) arrive or refresh.

Claude Code acts on the blocking decision from a ConfigChange hook's JSON output and discards `systemMessage` and `continue`. A blocked change surfaces no message to you or to Claude, whether you block with `reason` or with stderr on exit 2. Claude Code only writes a line to the debug log.

### CwdChanged

Runs when a shell command in the main conversation changes the working directory, for example when Claude executes a `cd` command. Use this to react to directory changes: reload environment variables, activate project-specific toolchains, or run setup scripts automatically. Pairs with [FileChanged](#filechanged) for tools like [direnv](https://direnv.net/) that manage per-directory environment.

CwdChanged hooks have access to [`CLAUDE_ENV_FILE`](#persist-environment-variables). If your hook writes variables to that file, they persist into subsequent Bash commands until the next CwdChanged event, when Claude Code clears them.

CwdChanged doesn't support matchers and fires on every occurrence.

#### CwdChanged input

In addition to the [common input fields](#common-input-fields), CwdChanged hooks receive `old_cwd` and `new_cwd`.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/my-project/src",
  "hook_event_name": "CwdChanged",
  "old_cwd": "/Users/my-project",
  "new_cwd": "/Users/my-project/src"
}
```

#### CwdChanged output

In addition to the [JSON output fields](#json-output) available to all hooks, CwdChanged hooks can return `watchPaths` to dynamically set which file paths [FileChanged](#filechanged) watches:

| Field | Description |
| :- | :- |
| `watchPaths` | Array of absolute paths. Replaces the current dynamic watch list. Paths from your `matcher` configuration are always watched. Returning an empty array clears the dynamic list, which is typical when entering a new directory |

CwdChanged hooks have no decision control. They can't block the directory change.

Claude Code reads `watchPaths` and `systemMessage` from their JSON output and discards `continue`. In interactive sessions, it shows the `systemMessage` as a brief terminal notification. The message doesn't reach the SDK message stream.

### DirectoryAdded

Runs after you add a working directory mid-session with the `/add-dir` command, or after an SDK client adds one with the `register_repo_root` control request. Use this to prepare a newly added repository, for example by installing its dependencies.

Claude Code doesn't fire this event when:

* You pass a directory with the `--add-dir` startup flag; [SessionStart](#sessionstart) covers those directories
* You add a directory on the `/permissions` Workspace tab
* You add a directory that is already a working directory or inside one

Claude Code fires DirectoryAdded after refreshing sandbox and permission state, so sandboxed tools already see the new directory when your hook runs. Hook commands themselves run unsandboxed.

Claude Code doesn't wait for the hook: the add completes immediately, and the hook runs in the background with the 600-second default timeout.

The matcher filters on how the directory was added:

| Matcher | When it fires |
| :- | :- |
| `slash_command` | You add a directory with `/add-dir` |
| `register_repo_root` | An SDK client adds a directory with the `register_repo_root` control request |

#### DirectoryAdded input

In addition to the [common input fields](#common-input-fields), DirectoryAdded hooks receive `directory` and `source`.

| Field | Description |
| :- | :- |
| `directory` | Absolute path of the directory that was added |
| `source` | How the directory was added, `"slash_command"` for `/add-dir` or `"register_repo_root"` for the SDK control request |

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/my-project",
  "hook_event_name": "DirectoryAdded",
  "directory": "/Users/my-other-repo",
  "source": "slash_command"
}
```

DirectoryAdded hooks have no decision control. They can't block the add, which has already completed when the hook runs. Claude Code discards the `continue` field from their JSON output and surfaces the rest differently per source:

* `slash_command`: Claude Code delivers the hook's `systemMessage` to Claude as context on the next conversation turn, rather than showing it to you. A count of failed hooks appears in the transcript. Full failure output goes to the debug log
* `register_repo_root`: Claude Code writes `systemMessage` output and failure output to the debug log only

### FileChanged

Runs when a watched file changes on disk. Claude Code detects changes with a filesystem watcher, not by inspecting tool calls, so it runs the hook no matter what changed the file: an `Edit` or `Write` tool call, a script Claude runs with `Bash`, or a process outside Claude Code entirely. A common use is reloading environment variables when project configuration files change.

The `matcher` for this event serves two roles:

* **Build the watch list**: the value is split on `|` and each segment is registered as a literal filename in the working directory, so `".envrc|.env"` watches exactly those two files. Regex patterns are not useful here: a value like `^\.env` would watch a file literally named `^\.env`.
* **Filter which hooks run**: when a watched file changes, the same value filters which hook groups run using the standard [matcher rules](#matcher-patterns) against the changed file's basename.

This example normalizes line endings in `data.csv` after any change, including a `Bash` command or an external script rewriting the file:

```json theme={null}
{
  "hooks": {
    "FileChanged": [
      {
        "matcher": "data.csv",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/normalize-line-endings.sh"
          }
        ]
      }
    ]
  }
}
```

The hook reads the changed file's absolute path from the `file_path` field of the [JSON input](#filechanged-input) on stdin. Its `grep` guard tests for the same thing `perl` removes, a CR at the end of a line, so the run after a normalization exits without touching the file. A looser guard loops forever, because `perl -i` rewrites the file even when it substitutes nothing and Claude Code runs the hook again after every rewrite. Save this script at `/path/to/normalize-line-endings.sh` and make it executable:

```bash theme={null}
#!/bin/bash
FILE=$(jq -r .file_path)
if grep -q $'\r$' "$FILE"; then
  perl -pi -e 's/\r$//' "$FILE"
fi
```

To confirm the hook works, ask Claude to append a CRLF line to `data.csv` with a `Bash` command. Claude Code runs the hook and the file ends up with LF endings.

To watch files you can't name up front, return [`watchPaths`](#filechanged-output) from a hook to update the watch list dynamically. Claude Code starts the watcher only when something names a file to watch, so seed the list with a FileChanged group whose matcher names at least one file, or with a [SessionStart](#sessionstart-decision-control) or [CwdChanged](#cwdchanged) hook that returns `watchPaths`. The matcher still filters which hook groups run when a watched file changes, so give the group that handles dynamic paths an omitted matcher, which matches every watched file and adds nothing to the watch list. A `"*"` matcher also matches every file, but Claude Code registers it in the watch list like any other value, as a literal file named `*`.

FileChanged hooks have access to [`CLAUDE_ENV_FILE`](#persist-environment-variables). Variables written to that file persist into subsequent Bash commands until the next [CwdChanged](#cwdchanged) event, when Claude Code clears them.

#### FileChanged input

In addition to the [common input fields](#common-input-fields), FileChanged hooks receive `file_path` and `event`.

| Field | Description |
| :- | :- |
| `file_path` | Absolute path to the file that changed |
| `event` | What happened: `"change"` for a modified file, `"add"` for a created file, or `"unlink"` for a deleted file |

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/my-project",
  "hook_event_name": "FileChanged",
  "file_path": "/Users/my-project/.envrc",
  "event": "change"
}
```

#### FileChanged output

In addition to the [JSON output fields](#json-output) available to all hooks, FileChanged hooks can return `watchPaths` to dynamically update which file paths are watched:

| Field | Description |
| :- | :- |
| `watchPaths` | Array of absolute paths. Replaces the current dynamic watch list. Paths from your `matcher` configuration are always watched. Use this when your hook script discovers additional files to watch based on the changed file |

FileChanged hooks have no decision control. They can't block the file change from occurring.

Claude Code reads `watchPaths` and `systemMessage` from their JSON output and discards `continue`. In interactive sessions, it shows the `systemMessage` as a brief terminal notification. The message doesn't reach the SDK message stream.

### WorktreeCreate

Runs when Claude Code creates a worktree in cases such as these:

* You start a session with `claude --worktree`
* Claude creates a worktree during a session and switches into it with the [`EnterWorktree`](https://code.claude.com/docs/en/tools-reference) tool
* A [subagent uses `isolation: "worktree"`](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope)
* A [workflow](https://code.claude.com/docs/en/workflows.md#migrate-many-files-in-parallel) runs an agent in its own worktree
* Claude Code isolates a [background session](https://code.claude.com/docs/en/agent-view.md#how-file-edits-are-isolated) in its own worktree
* [`claude remote-control`](https://code.claude.com/docs/en/remote-control#start-a-remote-control-session) in `worktree` mode starts a session in its own worktree

A WorktreeCreate hook doesn't run for a worktree Claude adds through Bash, and a plugin's hook doesn't run for the one created when you launch with `--worktree` and [`--tmux`](https://code.claude.com/docs/en/cli-reference#cli-flags):

* **`git worktree add` through Bash**: to inspect or block that command, add a [`PreToolUse`](#pretooluse) hook with the `Bash` matcher.
* **`--worktree` with `--tmux`**: Claude Code creates the worktree before it loads plugins, so a WorktreeCreate hook from a plugin doesn't run. To have your hook run with both flags, define it in a [settings file](#configuration) instead. Before v2.1.300, a plugin's WorktreeCreate hook didn't run with `--worktree` alone either.

By default Claude Code creates the isolated working copy with `git worktree`. Configuring a WorktreeCreate hook replaces that default git behavior, letting you use a different version control system like SVN, Perforce, or Mercurial.

Because the hook replaces the default behavior entirely, [`.worktreeinclude`](https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees) is not processed. If you need to copy local configuration files like `.env` into the new worktree, do it inside your hook script.

The hook must return the path to the created worktree directory. Claude Code uses this path as the working directory for the isolated session. See [WorktreeCreate output](#worktreecreate-output) for how each hook type returns the path.

Claude Code acts on the hook's success and the returned path, and discards `systemMessage` and `continue`.

This example creates an SVN working copy and prints the path for Claude Code to use. Replace the repository URL with your own:

```json theme={null}
{
  "hooks": {
    "WorktreeCreate": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'NAME=$(jq -r .name); DIR=\"$HOME/.claude/worktrees/$NAME\"; svn checkout https://svn.example.com/repo/trunk \"$DIR\" >&2 && echo \"$DIR\"'"
          }
        ]
      }
    ]
  }
}
```

The hook reads the worktree `name` from the JSON input on stdin, checks out a fresh copy into a new directory, and prints the directory path. The `echo` on the last line is what Claude Code reads as the worktree path. Redirect any other output to stderr so it doesn't interfere with the path.

#### WorktreeCreate input

In addition to the [common input fields](#common-input-fields), WorktreeCreate hooks receive the `name` field. This is a slug identifier for the new worktree, either specified by the user or auto-generated, for example `bold-oak-a3f2`.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "WorktreeCreate",
  "name": "feature-auth"
}
```

#### WorktreeCreate output

WorktreeCreate hooks don't use the standard allow/block decision model. Instead, the hook's success or failure determines the outcome. The hook must return the path to the created worktree directory:

* **Command hooks** (`type: "command"`): print the path as the last non-empty line of stdout. Claude Code strips ANSI escape codes before reading that line, so shell startup banners printed before your `echo` are ignored. Redirect any other hook output to stderr.
* **HTTP hooks** (`type: "http"`): return `{ "hookSpecificOutput": { "hookEventName": "WorktreeCreate", "worktreePath": "/absolute/path" } }` in the response body.

If the hook fails or produces no path, worktree creation fails with an error.

Claude Code resolves a relative path against the directory the hook ran in, collapsing any `.` or `..` segments in it. If the resulting path isn't a directory Claude Code can enter, the session prints an error naming the path and exits with code 1.

Claude Code refuses an absolute path that contains `.` or `..` segments, and any path that passes through a symlink below the repository root, because a symlink committed to the repository could redirect the worktree outside it. The error names the rejected component. Return a normalized path that doesn't pass through a symlink inside the repository. Before v2.1.216, worktree creation followed the hook's path without this screening.

### WorktreeRemove

Runs when Claude Code cleans up a worktree that your [`WorktreeCreate`](#worktreecreate) hook created. The event fires when:

* You exit an interactive [worktree session](https://code.claude.com/docs/en/worktrees.md#start-claude-in-a-worktree) and choose to remove the worktree when Claude Code prompts you
* You exit an interactive worktree session you haven't [named](https://code.claude.com/docs/en/sessions.md#name-your-sessions), Claude Code finds no changed or untracked files, and it removes the worktree without prompting you
* You delete a [background session](https://code.claude.com/docs/en/agent-view.md#what-deleting-a-session-removes) that runs in the worktree
* You ask Claude to exit and remove the worktree during a session, and Claude removes it with the [`ExitWorktree`](https://code.claude.com/docs/en/tools-reference) tool
* A session that [`claude remote-control`](https://code.claude.com/docs/en/remote-control#start-a-remote-control-session) started in `worktree` mode ends without crashing, and Claude Code finds no changed or untracked files and no new commits in its worktree
* You stop `claude remote-control` while sessions it started in `worktree` mode are still running, and Claude Code finds no changed or untracked files and no new commits in their worktrees

When a subagent or a workflow agent finishes, Claude Code keeps the worktree your WorktreeCreate hook made for it and doesn't run your WorktreeRemove hook. Remove those worktrees yourself when the work is done.

Claude Code doesn't prompt you before your hook runs for an `ExitWorktree` call or a `claude remote-control` cleanup. `ExitWorktree` refuses to remove a hook-created worktree unless the call passes [`discard_changes: true`](https://code.claude.com/docs/en/agent-sdk/typescript#exitworktree), which makes your hook the last check on that route.

Claude Code uses git to look for changed or untracked files, so it finds none in a worktree that isn't a git checkout or inside one, even when the directory holds uncommitted work. Check for that work in your WorktreeRemove hook before it deletes anything.

For git-based worktrees, Claude Code handles cleanup automatically with `git worktree remove`. If you configured a WorktreeCreate hook, pair it with a WorktreeRemove hook to control cleanup:

* **No WorktreeRemove hook**: Claude Code falls back to git for a removal at exit or through `ExitWorktree`, and keeps the worktree when `claude remote-control` cleans up:
  * **You exit a worktree session, or Claude calls `ExitWorktree`**: Claude Code removes the path your WorktreeCreate hook returned as `git worktree remove --force` would, so a worktree git recognizes is removed. A worktree git doesn't recognize, for example one your hook created with a non-git version control system, stays on disk.
  * **`claude remote-control` cleans up a session's worktree**: the worktree stays on disk, and the terminal running `claude remote-control` shows `worktree removal failed, kept: <path>`.
  * **You delete a background session**: see [What deleting a session removes](https://code.claude.com/docs/en/agent-view.md#what-deleting-a-session-removes).
* **Hook exits 0**: the worktree counts as removed. Claude Code reads nothing else from the hook, so make sure your hook deleted the directory.
* **Hook exits non-zero**: the removal fails if the directory at `worktree_path` still exists afterward, and the worktree stays on disk with no git fallback. A hook that deleted the directory before exiting non-zero counts as removed. For how the failure is reported, see [WorktreeRemove input](#worktreeremove-input).

Claude Code never deletes a branch belonging to a hook-created worktree, because it only knows the path your WorktreeCreate hook returned. If your WorktreeCreate hook creates a branch, delete it in your WorktreeRemove hook.

Claude Code discards a WorktreeRemove hook's [JSON output fields](#json-output), such as `systemMessage` and `continue`.

For a background-session delete, Claude Code verifies the stored worktree path before running the hook and refuses a path that is a symlink or passes through one below the repository root. On that route, the hook runs for a worktree that still contains files only when you confirm the delete in [agent view](https://code.claude.com/docs/en/agent-view.md#what-deleting-a-session-removes); for such a worktree, [`claude rm`](https://code.claude.com/docs/en/agent-view#manage-sessions-from-the-shell) keeps the session and worktree instead. Before v2.1.216, the hook ran on the stored path without these checks.

Claude Code passes the path returned by WorktreeCreate as `worktree_path` in the hook input. This example reads that path and removes the directory:

```json theme={null}
{
  "hooks": {
    "WorktreeRemove": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'jq -r .worktree_path | xargs rm -rf'"
          }
        ]
      }
    ]
  }
}
```

#### WorktreeRemove input

In addition to the [common input fields](#common-input-fields), WorktreeRemove hooks receive the `worktree_path` field, which is the absolute path to the worktree being removed.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "WorktreeRemove",
  "worktree_path": "/Users/.../my-project/.claude/worktrees/feature-auth"
}
```

A WorktreeRemove hook's exit code decides the outcome. When a hook exits non-zero and the directory at `worktree_path` still exists afterward, the removal fails:

* The worktree stays on disk, and the hook's command and stderr go to the [debug log](#debug-hooks).
* If you were deleting a background session, the session stays too. The refusal message in [agent view](https://code.claude.com/docs/en/agent-view.md#what-deleting-a-session-removes) reports how the hook ended, such as `exited 1`, quotes the start of its stderr, and says whether deleting the session again removes the directory anyway.
* If `claude remote-control` was cleaning up a session's worktree, the terminal running it shows `worktree removal failed, kept: <path>`.

### PreCompact

Runs before Claude Code is about to run a compact operation.

The matcher value indicates whether compaction was triggered manually or automatically:

| Matcher | When it fires |
| :- | :- |
| `manual` | `/compact` |
| `auto` | Auto-compact when the conversation reaches the [auto-compact window](https://code.claude.com/docs/en/model-config.md#set-the-auto-compact-window), and [idle compaction](https://code.claude.com/docs/en/settings-reference.md#idlecompaction) |

Exit with code 2 to block compaction. For a manual `/compact`, the stderr message is shown to the user. You can also block by returning JSON with `"decision": "block"`.

Blocking automatic compaction has different effects depending on when it fires. If compaction was triggered proactively before the context limit, Claude Code skips it and the conversation continues uncompacted. If compaction was triggered to recover from a context-limit error already returned by the API, the underlying error surfaces and the current request fails.

Claude Code discards a PreCompact hook's `systemMessage` and `continue` fields.

#### PreCompact input

In addition to the [common input fields](#common-input-fields), PreCompact hooks receive `trigger` and `custom_instructions`. For `manual`, `custom_instructions` contains what the user passes into `/compact` and is `null` when they pass nothing. For `auto`, `custom_instructions` is `null`.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "PreCompact",
  "trigger": "manual",
  "custom_instructions": null
}
```

### PostCompact

Runs after Claude Code completes a compact operation. Use this event to react to the new compacted state, for example to log the generated summary or update external state. Claude Code discards a PostCompact hook's `systemMessage` and `continue` fields.

The same matcher values apply as for `PreCompact`:

| Matcher | When it fires |
| :- | :- |
| `manual` | After `/compact` |
| `auto` | After auto-compact when the conversation reaches the [auto-compact window](https://code.claude.com/docs/en/model-config.md#set-the-auto-compact-window), and after [idle compaction](https://code.claude.com/docs/en/settings-reference.md#idlecompaction) |

#### PostCompact input

In addition to the [common input fields](#common-input-fields), PostCompact hooks receive `trigger` and `compact_summary`. The `compact_summary` field contains the conversation summary generated by the compact operation.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "PostCompact",
  "trigger": "manual",
  "compact_summary": "Summary of the compacted conversation..."
}
```

PostCompact hooks have no decision control. They can't affect the compaction result but can perform follow-up tasks.

### PreModelSwitch

Runs before Claude Code applies a model switch that you or a client requested. Use it to block a switch, require confirmation, or show what the switch will cost before it happens.

PreModelSwitch requires Claude Code v2.1.251 or later. Claude Code runs it for these requests:

* `/model <name>` and the `/model` picker
* The `Option+P` or `Alt+P` model picker
* The Model setting in `/config`
* Turning on [fast mode](https://code.claude.com/docs/en/fast-mode.md) when that changes the session's model
* A `set_model` request, or a model change in an `apply_flag_settings` request, from an [Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript.md#query-object) host or [Remote Control](https://code.claude.com/docs/en/remote-control.md)

Claude Code doesn't run PreModelSwitch hooks for switches it makes on its own, such as an [automatic model fallback](https://code.claude.com/docs/en/model-config.md#automatic-model-fallback) or restoring the model when you resume a session. Those changes reach [PostModelSwitch](#postmodelswitch) only.

Claude Code compares the matcher against the canonical name of the model the session is switching to, ignoring any `[1m]` suffix. An alias such as `opus`, a dated model ID, and a provider-specific ID such as an Amazon Bedrock model ID all match the one canonical name they resolve to, so `claude-opus-5` covers every spelling of Opus 5.

When Claude Code can't determine a canonical name for the target, for example a custom model ID that only your [LLM gateway](https://code.claude.com/docs/en/llm-gateway) knows, it runs every PreModelSwitch hook regardless of matcher. A hook that blocks should therefore check `to_model` from its input rather than rely on the matcher alone.

Write the matcher as an exact name, a `|`-separated list such as `claude-opus-4-6|claude-opus-5`, or a regular expression such as `.*opus.*`. This example uses an exact-name matcher and also checks `to_model` from the hook input, so it refuses a switch to Opus 4.6 by exiting with code 2 and lets any other target through:

**macOS/Linux**

The command checks `to_model` with `jq`:

```json theme={null}
{
  "hooks": {
    "PreModelSwitch": [
      {
        "matcher": "claude-opus-4-6",
        "hooks": [
          {
            "type": "command",
            "command": "jq -e '.to_model | test(\"opus-4-6\")' > /dev/null && { echo 'Opus 4.6 is retired for this project. Use a newer model.' >&2; exit 2; }; exit 0"
          }
        ]
      }
    ]
  }
}
```

**Windows (PowerShell)**

Register a command hook that runs a script through PowerShell:

```json theme={null}
{
  "hooks": {
    "PreModelSwitch": [
      {
        "matcher": "claude-opus-4-6",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-opus-46.ps1"
            ]
          }
        ]
      }
    ]
  }
}
```

Save this script to `.claude/hooks/block-opus-46.ps1` in your project:

```powershell theme={null}
$hookInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($hookInput.to_model -match 'opus-4-6') {
  [Console]::Error.WriteLine('Opus 4.6 is retired for this project. Use a newer model.')
  exit 2
}
exit 0
```

To confirm the hook works, run `/model claude-opus-4-6` from a session running a different model. Claude Code keeps the current model and reports that a PreModelSwitch hook blocked the switch, with your message as the reason.

#### PreModelSwitch input

In addition to the [common input fields](#common-input-fields), PreModelSwitch hooks receive the fields in this table. The last five describe what re-sending the conversation to the new model costs, so a hook can show that figure before the switch happens.

| Field | Type | Description |
| :- | :- | :- |
| `from_model` | string | Model ID the switch changes from |
| `to_model` | string | Model ID the switch changes to. The matcher compares against this model's canonical name |
| `requested_model` | string or `null` | The model the request named: an alias such as `opus`, a full model ID, or `null` when the request was for the default model |
| `source` | string | Where the request came from: `"command"` for `/model <name>`, the Model setting in `/config`, or turning on fast mode; `"picker"` for a model picker; `"sdk"` for a `set_model` request, or a model change in an `apply_flag_settings` request, from an Agent SDK host or Remote Control |
| `context_tokens` | number | Tokens the next request re-sends as its prompt: the input, cache read, cache creation, and output tokens of the last response in the main conversation, combined. `0` before the first response |
| `prompt_cache_warm` | boolean | Whether the current model's prompt cache is likely still warm, meaning the switch forfeits it |
| `cache_ttl` | string | [Prompt cache lifetime](https://code.claude.com/docs/en/prompt-caching.md#cache-lifetime) of the main conversation at the time of this switch: `"5m"` or `"1h"` |
| `estimated_cache_write_usd` | number | Estimated cost in US dollars of writing `context_tokens` to the prompt cache on `to_model` at the `cache_ttl` rate, excluding the next response. The server may not need to re-cache the whole context, so treat it as an estimate |
| `pricing` | string | How Claude Code priced `estimated_cache_write_usd`: `"configured"` at your organization's own rates when it has configured them, `"catalog"` at list price, or `"default"` when `to_model` has no known price and Claude Code assumed a default rate |

This example shows the input for `/model opus` in a session running Sonnet 5:

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "PreModelSwitch",
  "from_model": "claude-sonnet-5",
  "to_model": "claude-opus-5",
  "requested_model": "opus",
  "source": "command",
  "context_tokens": 182340,
  "prompt_cache_warm": true,
  "cache_ttl": "5m",
  "estimated_cache_write_usd": 1.1396,
  "pricing": "catalog"
}
```

#### PreModelSwitch decision control

`PreModelSwitch` hooks can cancel the switch, ask the user to confirm it, or let it proceed. Exit code 2 or a top-level `decision: "block"` cancels the switch.

For finer control, return `permissionDecision` and `permissionDecisionReason` in a `hookSpecificOutput` object, as on [PreToolUse](#pretooluse-decision-control). `PreModelSwitch` accepts `"allow"`, `"deny"`, and `"ask"`. It doesn't accept `"defer"`, `updatedInput`, or `additionalContext`. The table below describes both fields:

| Field | Description |
| :- | :- |
| `permissionDecision` | `"allow"` proceeds and skips the [confirmation Claude Code shows while the prompt cache is warm](https://code.claude.com/docs/en/prompt-caching.md#switching-models). `"deny"` cancels the switch. `"ask"` prompts the user to confirm it |
| `permissionDecisionReason` | For `"deny"`, shown to the user as the reason the switch was blocked, or returned as the error for a `set_model` request. For `"ask"`, shown in the confirmation prompt. Ignored for `"allow"` |

Only `/model` in an interactive session can show the `"ask"` prompt. On every other surface, including non-interactive mode with the `-p` flag, `/config`, and `set_model` requests, Claude Code treats `"ask"` as a refusal.

This example asks the user to confirm and quotes the token count from `context_tokens`:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PreModelSwitch",
    "permissionDecision": "ask",
    "permissionDecisionReason": "Switching now re-sends about 180k tokens to the new model. Continue?"
  }
}
```

When multiple PreModelSwitch hooks return different decisions, precedence is `deny` > `ask` > `allow`.

Claude Code shows the user any `systemMessage` your hook returns regardless of the decision, so a cost-report hook can return `{"systemMessage": "..."}` and exit 0.

#### PreModelSwitch timeouts and other exit codes

A PreModelSwitch hook that doesn't respond before its timeout blocks the switch. The default timeout for this event is 30 seconds.

An exit code other than 0 or 2 without valid JSON output is a [non-blocking error](#other-exit-codes), so the switch goes ahead, except for hooks [whose failure blocks it](#block-the-action-when-a-hook-fails).

### PostModelSwitch

Runs after the session's model changes. Use it to give Claude model-specific guidance without editing every CLAUDE.md, for example an organization-wide instruction that applies on certain models.

PostModelSwitch requires Claude Code v2.1.251 or later. It can't block, because the model has already changed. Claude Code runs PostModelSwitch hooks after any of these changes:

* A switch you or a client requested
* An [automatic model fallback](https://code.claude.com/docs/en/model-config.md#automatic-model-fallback), which changes the session's model
* A setting such as [`opusplan`](https://code.claude.com/docs/en/model-config#opusplan-model-setting) entering or leaving plan mode
* Claude Code restoring the model when you resume a session

Claude Code doesn't run PostModelSwitch hooks when a model from a [fallback model chain](https://code.claude.com/docs/en/model-config.md#fallback-model-chains) serves a turn, because that substitution lasts one turn and leaves the session's model unchanged.

The matcher follows the same rules as [PreModelSwitch](#premodelswitch): Claude Code compares it against the canonical name of the model the session switched to.

This example adds guidance whenever the session's model changes to any Opus model:

```json theme={null}
{
  "hooks": {
    "PostModelSwitch": [
      {
        "matcher": ".*opus.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'On Opus, delegate implementation work to subagents and keep this conversation for planning and review.'"
          }
        ]
      }
    ]
  }
}
```

To confirm the hook works, switch to an Opus model from a session running a different model, for example run `/model opus` from a Sonnet session, then ask Claude what guidance it has about the current model.

#### PostModelSwitch input

PostModelSwitch hooks receive the same fields as [PreModelSwitch](#premodelswitch-input), with `hook_event_name` set to `"PostModelSwitch"` and two more `source` values: `"auto"` for an automatic fallback or other change Claude Code made on its own, and `"resume"` for the model restored when you resume a session.

`requested_model` is `null` when `source` is `"auto"`. When `source` is `"resume"`, it is the saved model setting Claude Code restored.

#### PostModelSwitch decision control

Claude Code takes your hook's [plain-text stdout](#exit-code-0) on exit 0, or `additionalContext` from JSON output, and delivers it to Claude with the next request after the switch. In addition to the [JSON output fields](#json-output) available to all hooks, you can return:

| Field | Description |
| :- | :- |
| `additionalContext` | String added to Claude's context with the next request. See [Add context for Claude](#add-context-for-claude) |

If the hook hasn't finished within five seconds after you send the next prompt, Claude Code sends that request without the output and attaches it to the following request instead. If the model changes several times before the next request, Claude Code delivers only the output for the last switch's target model.

### SessionEnd

Runs when a Claude Code session ends. Useful for cleanup tasks, logging session
statistics, or saving session state. Supports matchers to filter by exit reason.

The `reason` field in the hook input indicates why the session ended:

| Reason | Description |
| :- | :- |
| `clear` | Session cleared with `/clear` command |
| `resume` | Session switched via interactive `/resume` |
| `logout` | User logged out |
| `prompt_input_exit` | User exited while prompt input was visible |
| `other` | Other exit reasons |
| `bypass_permissions_disabled` | Removed in v2.1.234; Claude Code doesn't send it. Drop it from your `SessionEnd` matchers |

#### SessionEnd input

In addition to the [common input fields](#common-input-fields), SessionEnd hooks receive a `reason` field indicating why the session ended. See the [reason table](#sessionend) above for all values.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

SessionEnd hooks have no decision control. They can't block session termination but can perform cleanup tasks. Claude Code discards their [JSON output fields](#json-output), such as `systemMessage`.

SessionEnd hooks have a default timeout of 1.5 seconds. It applies when you exit, run `/clear`, or switch sessions with interactive `/resume`. You can give a hook more time in two ways:

* **Per-hook `timeout`**: set `timeout` in that hook's configuration. The overall budget rises automatically to match the highest per-hook `timeout` in your settings files, up to 60 seconds. If you raise the budget this way, a hook without its own `timeout` still keeps the default. Timeouts set on plugin-provided hooks don't raise the budget.
* **`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`**: set this environment variable in milliseconds to override the budget explicitly. The value you set also becomes the timeout for each hook without its own `timeout`.

This example sets the budget to 5 seconds:

```bash theme={null}
CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=5000 claude
```

Before v2.1.268, `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` raised only the overall budget, and a hook without its own `timeout` was still canceled after 1.5 seconds.

### Elicitation

Runs when an MCP server requests user input mid-task. By default, Claude Code shows an interactive dialog for the user to respond. Hooks can intercept this request and respond programmatically, skipping the dialog entirely.

For a complete hook with its settings entry and script, see [Answer a form request from a script](#answer-a-form-request-from-a-script).

The matcher field matches against the MCP server name.

#### Elicitation input

In addition to the [common input fields](#common-input-fields), Elicitation hooks receive `mcp_server_name`, `message`, and optional `mode`, `url`, `elicitation_id`, and `requested_schema` fields.

For form-mode elicitation, the most common case:

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "Elicitation",
  "mcp_server_name": "my-mcp-server",
  "message": "Please provide your credentials",
  "mode": "form",
  "requested_schema": {
    "type": "object",
    "properties": {
      "username": { "type": "string", "title": "Username" }
    }
  }
}
```

For URL-mode elicitation, used for browser-based authentication:

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "Elicitation",
  "mcp_server_name": "my-mcp-server",
  "message": "Please authenticate",
  "mode": "url",
  "url": "https://auth.example.com/login"
}
```

#### Elicitation output

An Elicitation hook can answer the request for the user, decline or cancel it, or leave it to the dialog. To answer, decline, or cancel, exit 0 and print a `hookSpecificOutput` object with an `action`. The server gets your answer and no dialog appears. Each row of this table shows what to return for one outcome and what the MCP server receives:

| To | Return | The server receives |
| :- | :- | :- |
| Answer for the user | `"action": "accept"`, with the form field values in `content` | `accept` with your `content` |
| Decline the request | `"action": "decline"` | `decline` |
| Cancel the request | `"action": "cancel"` | `cancel` |
| Leave the request to the user | No output, with exit code 0 | The user's answer from the [dialog](https://code.claude.com/docs/en/mcp.md#respond-to-mcp-elicitation-requests) |

This output answers the form-mode request shown under [Elicitation input](#elicitation-input). The keys in `content` are the property names from that request's `requested_schema`:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "Elicitation",
    "action": "accept",
    "content": {
      "username": "alice"
    }
  }
}
```

This output declines a request:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "Elicitation",
    "action": "decline"
  }
}
```

In the dialog, selecting **Decline** sends `decline` and pressing `Esc` sends `cancel`, so return the one you want the server to see.

For a URL-mode request, a hook that returns `accept` skips the dialog, so the URL never opens.

Claude Code discards `reason`, `systemMessage`, and `continue` from an Elicitation hook's JSON output, whichever `action` you return.

#### Other ways to decline an elicitation

Your hook can also decline in these ways. The server receives the same `decline` as for `"action": "decline"`:

* **Exits with code 2**: Claude Code ignores a `hookSpecificOutput` printed by the same hook
* **Prints a top-level `"decision": "block"`**: the block overrides an `action` in the same output

When several hooks match the same request, a decline from one of them overrides an `accept` or `cancel` from another.

This script declines URL-mode requests and leaves form requests to the dialog:

```bash theme={null}
#!/bin/bash
if [ "$(jq -r '.mode')" = "url" ]; then
  exit 2
fi
```

Neither the user nor the server sees why your hook declined, because Claude Code doesn't show your stderr or your `reason`.

Claude Code ignored a top-level `decision` from `Elicitation` and `ElicitationResult` hooks from v2.1.105 until the fix in v2.1.284.

#### Answer a form request from a script

This example answers one recurring question for the user. An MCP server named `issue-tracker` asks for a project key in a form, and the hook fills in `DOCS`. The script accepts when `project_key` is the form's single field. For any other request it prints nothing, so the dialog appears.

**macOS/Linux**

Register a command hook for the event in your settings file, with the server name as the matcher:

```json theme={null}
{
  "hooks": {
    "Elicitation": [
      {
        "matcher": "issue-tracker",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/answer-project-key.sh",
            "args": []
          }
        ]
      }
    ]
  }
}
```

Save this script to `.claude/hooks/answer-project-key.sh` in your project and make it executable with `chmod +x`:

```bash theme={null}
#!/bin/bash
input=$(cat)
fields=$(jq -c '.requested_schema.properties // {} | keys' <<<"$input")

if [ "$fields" = '["project_key"]' ]; then
  jq -n '{hookSpecificOutput: {hookEventName: "Elicitation", action: "accept", content: {project_key: "DOCS"}}}'
fi
```

**Windows (PowerShell)**

Register a command hook that runs the script through PowerShell, with the server name as the matcher:

```json theme={null}
{
  "hooks": {
    "Elicitation": [
      {
        "matcher": "issue-tracker",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/answer-project-key.ps1"
            ]
          }
        ]
      }
    ]
  }
}
```

Save this script to `.claude/hooks/answer-project-key.ps1` in your project:

```powershell theme={null}
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$fields = @($request.requested_schema.properties.PSObject.Properties.Name)

if ($fields.Count -eq 1 -and $fields[0] -eq 'project_key') {
  @{
    hookSpecificOutput = @{
      hookEventName = "Elicitation"
      action = "accept"
      content = @{ project_key = "DOCS" }
    }
  } | ConvertTo-Json -Depth 3
}
```

To confirm the hook works, start Claude Code with `claude --debug` and give Claude a task that makes the server ask for the project key. No dialog appears, and the [debug log](#debug-hooks) has a line that ends with `Elicitation resolved by hook: {"action":"accept","content":{"project_key":"DOCS"}}`.

### ElicitationResult

Runs after a user responds to an MCP elicitation. Hooks can observe, modify, or block the response before it is sent back to the MCP server.

When an [Elicitation](#elicitation) hook answers a request, Claude Code sends that answer to the server without running ElicitationResult hooks.

The matcher field matches against the MCP server name.

#### ElicitationResult input

In addition to the [common input fields](#common-input-fields), ElicitationResult hooks receive `mcp_server_name`, `action`, and optional `mode`, `elicitation_id`, and `content` fields.

```json theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "ElicitationResult",
  "mcp_server_name": "my-mcp-server",
  "action": "accept",
  "content": { "username": "alice" },
  "mode": "form"
}
```

#### ElicitationResult output

An ElicitationResult hook can let the user's response through, change its values, or block it. To change or block the response, exit 0 and print a `hookSpecificOutput` object with an `action`. Each row of this table shows what to return for one outcome and what the MCP server receives:

| To | Return | The server receives |
| :- | :- | :- |
| Let the response through | No output, with exit code 0 | The user's response, unchanged |
| Change the submitted values | `"action": "accept"`, with the new values in `content` | `accept` with your `content` in place of the user's values |
| Block the response | `"action": "decline"` | `decline`, without the user's values |
| Cancel the request | `"action": "cancel"` | `cancel`, along with the values the user submitted. To withhold them, return `"decline"` |

This output changes the response shown under [ElicitationResult input](#elicitationresult-input), so the server receives `alice@example.com` where the user submitted `alice`:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "ElicitationResult",
    "action": "accept",
    "content": {
      "username": "alice@example.com"
    }
  }
}
```

Your `content` replaces the user's whole `content` object, so include the fields you aren't changing. Return `action` along with it, because Claude Code ignores a `hookSpecificOutput` that has no `action`.

ElicitationResult hooks also run when the user declines or cancels, and your `action` replaces theirs. Check that the input's `action` is `accept` before you return `accept`, or your hook turns a declined request into an accepted one. This script makes the same change when the user accepted, keeps the other fields, and prints nothing otherwise:

```bash theme={null}
#!/bin/bash
input=$(cat)

if [ "$(jq -r '.action' <<<"$input")" = "accept" ]; then
  jq '{hookSpecificOutput: {hookEventName: "ElicitationResult", action: "accept", content: (.content + {username: (.content.username + "@example.com")})}}' <<<"$input"
fi
```

This output blocks the response:

```json theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "ElicitationResult",
    "action": "decline"
  }
}
```

Exit code 2 and a top-level `"decision": "block"` also block the response. [Other ways to decline an elicitation](#other-ways-to-decline-an-elicitation) covers which one takes effect when a hook combines them, what the user sees, and which versions ignored `decision`.

Claude Code discards `reason`, `systemMessage`, and `continue` from an ElicitationResult hook's JSON output, whichever `action` you return.

## Prompt-based hooks

In addition to command, HTTP, and MCP tool hooks, Claude Code supports prompt-based hooks (`type: "prompt"`) that use an LLM to evaluate whether to allow or block an action, and agent hooks (`type: "agent"`) that spawn an agentic verifier with tool access. Not all events support every hook type.

Events that support all five hook types (`command`, `http`, `mcp_tool`, `prompt`, and `agent`):

* `PermissionDenied`
* `PostToolBatch`
* `PostToolUse`
* `PostToolUseFailure`
* `PreToolUse`
* `Stop`
* `SubagentStop`
* `TaskCompleted`
* `TaskCreated`
* `TeammateIdle`
* `UserPromptExpansion`
* `UserPromptSubmit`

`PermissionRequest` supports `command`, `http`, `mcp_tool`, and `prompt` hooks but not `agent` hooks. If you configure an agent hook on this event, Claude Code skips it and the permission flow proceeds unchanged. To allow or deny from a hook, return the [decision object](#permissionrequest-decision-control) from a command or HTTP hook.

Events that support `command`, `http`, and `mcp_tool` hooks but not `prompt` or `agent`:

* `ConfigChange`
* `CwdChanged`
* `DirectoryAdded`
* `Elicitation`
* `ElicitationResult`
* `FileChanged`
* `InstructionsLoaded`
* `MessageDisplay`
* `Notification`
* `PostCompact`
* `PostModelSwitch`
* `PreCompact`
* `PreModelSwitch`
* `SessionEnd`
* `StopFailure`
* `SubagentStart`
* `WorktreeCreate`
* `WorktreeRemove`

`SessionStart` and `Setup` support `command` and `mcp_tool` hooks, and [MCP tool hook fields](#mcp-tool-hook-fields) describes when their `mcp_tool` hooks run. They don't support `http`, `prompt`, or `agent` hooks.

### How prompt-based hooks work

Instead of executing a Bash command, prompt-based hooks:

1. Send the hook input and your prompt to a Claude model, by default the one Claude Code uses for [background functionality](https://code.claude.com/docs/en/costs.md#background-token-usage)
2. The LLM responds with structured JSON containing a decision
3. Claude Code processes the decision automatically

### Prompt hook configuration

Set `type` to `"prompt"` and provide a `prompt` string instead of a `command`. Use the `$ARGUMENTS` placeholder to inject the hook's JSON input data into your prompt text.

In a prompt or [agent hook](#agent-based-hooks), you can write the `prompt` as a rule about what to block or allow, such as "Block any Bash command that reads `.env` files", or as a condition that must hold, such as "All unit tests pass".

This `Stop` hook asks the LLM to evaluate whether all tasks are complete before allowing Claude to finish:

```json theme={null}
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if Claude should stop: $ARGUMENTS. Check if all tasks are complete."
          }
        ]
      }
    ]
  }
}
```

| Field | Required | Description |
| :- | :- | :- |
| `type` | yes | Must be `"prompt"` |
| `prompt` | yes | The prompt text to send to the LLM. Use `$ARGUMENTS` as a placeholder for the hook input JSON. If `$ARGUMENTS` is not present, input JSON is appended to the prompt |
| `model` | no | Model to use for evaluation. Defaults to the model Claude Code uses for [background functionality](https://code.claude.com/docs/en/costs.md#background-token-usage) |
| `timeout` | no | Timeout in seconds. Default: 30 |
| `continueOnBlock` | no | On the events it applies to, `true` feeds an `ok: false` reason back to Claude and continues instead of ending the turn. Default: `false`. See [Response schema](#response-schema) for per-event behavior |

### Response schema

The LLM must respond with JSON containing:

```json theme={null}
{
  "ok": true | false,
  "reason": "Explanation for the decision",
  "impossible": true | false
}
```

| Field | Description |
| :- | :- |
| `ok` | `true` to allow. For `false`, see the per-event behavior below |
| `reason` | Required when `ok` is `false` |
| `impossible` | Optional. The model returns it with `ok: false` when it judges the condition can never be satisfied. On `Stop` and `SubagentStop`, Claude Code then lets the turn end instead of feeding the reason back. Agent hooks and other events ignore it |

What happens on `ok: false` depends on the event:

* `Stop` and `SubagentStop`: the reason is fed back to Claude as its next instruction and the turn continues, unless the response also sets `impossible: true`, in which case Claude Code allows the stop and the turn ends
* `PreToolUse`: the tool call is denied; by default the turn ends and the deny reason appears in the chat as a warning line. Set `continueOnBlock: true` to instead return the reason to Claude as the tool error so it can adjust and continue, equivalent to a command hook's `permissionDecision: "deny"`
* `PostToolUse`: by default the turn ends and the reason appears in the chat as a warning line. Set `continueOnBlock: true` to feed the reason back to Claude and continue the turn instead
* `PostToolBatch`, `UserPromptSubmit`, and `UserPromptExpansion`: the turn ends and the reason appears as a warning line. These events end the turn on `decision: "block"` regardless of `continue`
* `PostToolUseFailure` and `TaskCreated`: the reason is returned to Claude as a tool error and the turn continues, regardless of `continueOnBlock`
* `TaskCompleted`: when it fires because a task is marked completed during a turn, the reason is returned to Claude as a tool error and the turn continues, regardless of `continueOnBlock`. When it fires because a teammate stops, it behaves like `TeammateIdle` and halts the teammate by default
* `TeammateIdle`: by default the teammate stops and the reason appears as a warning line. Set `continueOnBlock: true` to feed the reason back to the teammate and keep it working instead
* `PermissionRequest`: `ok: false` has no effect. To deny an approval from a hook, use a [command hook](#command-hook-fields) returning `hookSpecificOutput.decision.behavior: "deny"`
* `PermissionDenied`: `ok: false` has no effect because the denial already happened. The only output this event reads is `hookSpecificOutput.retry`, which prompt and agent hooks can't set. They run on this event, but their output is discarded. Use a [command hook](#command-hook-fields) to return `retry`

If you need finer control on any event, use a [command hook](#command-hook-fields) with the per-event fields described in [Decision control](#decision-control).

### Check multiple conditions before stopping

This `Stop` hook uses a detailed prompt to check three conditions before allowing Claude to stop. `SubagentStop` hooks use the same format to evaluate whether a [subagent](https://code.claude.com/docs/en/sub-agents.md) should stop. If the model returns `"ok": false` because the condition isn't met yet, Claude continues working with the provided reason as its next instruction:

```json theme={null}
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "You are evaluating whether Claude should stop working. Context: $ARGUMENTS\n\nAnalyze the conversation and determine if:\n1. All user-requested tasks are complete\n2. Any errors need to be addressed\n3. Follow-up work is needed\n\nRespond with JSON: {\"ok\": true} to allow stopping, or {\"ok\": false, \"reason\": \"your explanation\"} to continue working.",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Agent-based hooks

> [!WARNING]
>
> Agent hooks are experimental. Behavior and configuration may change in future releases. For production workflows, prefer [command hooks](#command-hook-fields).

Agent-based hooks (`type: "agent"`) are like prompt-based hooks but with multi-turn tool access. Instead of a single LLM call, an agent hook spawns a subagent that can read files, search code, and inspect the codebase to verify conditions. Agent hooks support the same events as [prompt-based hooks](#prompt-based-hooks), except `PermissionRequest`.

### How agent hooks work

When an agent hook fires:

1. Claude Code spawns a subagent with your prompt and the hook's JSON input
2. The subagent can use tools like Read, Grep, and Glob to investigate
3. After up to 50 turns, the subagent returns a structured `{ "ok": true/false }` decision
4. Claude Code allows the action if `ok` is `true`. If `ok` is `false`, Claude Code handles the block the same way as a prompt hook with `continueOnBlock: true` on that event, as listed under [Response schema](#response-schema)

Agent hooks are useful when verification requires inspecting actual files or test output, not just evaluating the hook input data alone.

### Agent hook configuration

Set `type` to `"agent"` and provide a `prompt` string, using `$ARGUMENTS` as a placeholder for the hook input JSON. The configuration fields are the same as [prompt hooks](#prompt-hook-configuration), except that agent hooks have a longer default timeout of 60 seconds and no `continueOnBlock` field.

The response schema is `{ "ok": true }` to allow or `{ "ok": false, "reason": "..." }` to block. On `ok: false`, Claude Code handles an agent hook the way it handles a [prompt hook with `continueOnBlock: true`](#response-schema) on the same event; agent hooks have no `continueOnBlock` field, and don't support the prompt-hook `impossible` field.

This `Stop` hook verifies that all unit tests pass before allowing Claude to finish:

```json theme={null}
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "agent",
            "prompt": "Verify that all unit tests pass. Run the test suite and check the results. $ARGUMENTS",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

## Run hooks in the background

By default, hooks block Claude's execution until they complete. For long-running tasks like deployments, test suites, or external API calls, set `"async": true` to run the hook in the background while Claude continues working. Async hooks can't block or control Claude's behavior: response fields like `decision`, `permissionDecision`, and `continue` have no effect, because the action they would have controlled has already completed.

### Configure an async hook

Add `"async": true` to a command hook's configuration to run it in the background without blocking Claude. This field is only available on `type: "command"` hooks.

This hook runs a test script after every `Write` tool call. Claude continues working immediately while `run-tests.sh` executes. When the script finishes, its output is delivered on the next conversation turn:

```json theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/run-tests.sh",
            "async": true
          }
        ]
      }
    ]
  }
}
```

Once an async hook is running in the background, Claude Code doesn't enforce `timeout` on it. Claude Code still enforces `timeout` on a hook you run with `asyncRewake`.

Claude Code delivers an async hook's results only while the session runs:

* In [non-interactive mode](https://code.claude.com/docs/en/headless.md) with the `-p` flag, Claude Code kills any async hook still running at teardown and finalizes it with outcome `cancelled`
* If your hook's work must outlive a `claude -p` session, start a fully detached process from it

### How async hooks execute

When an async hook fires, Claude Code starts the hook process and immediately continues without waiting for it to finish. The hook receives the same JSON input via stdin as a synchronous hook.

After the background process exits, Claude Code delivers the `additionalContext` and `systemMessage` fields from the hook's JSON response to Claude on the next conversation turn, except for [repeated `SessionStart` output](#limitations). Unlike a synchronous hook's `systemMessage`, neither field is shown to you.

Print the JSON response alone on stdout or on one line of its own:

* **Alone on stdout**: when the response is the only text on stdout, it can span several lines, such as pretty-printed `jq` output. Spanning several lines requires Claude Code v2.1.295 or later.
* **On one line of its own**: an async hook can print other text to stdout when the response fits on one line by itself, for example with `jq -c`.

Claude Code validates that JSON response against the same [output schema](#json-output) as synchronous hooks, and drops any field whose value has the wrong type, such as a `systemMessage` that isn't a string, instead of delivering it. Run with `--debug` to see a warning naming each dropped field.

Async hook completion notifications are suppressed by default. To see them, enable verbose mode with `Ctrl+O` or start Claude Code with `--verbose`.

### Run tests after file changes

This hook starts a test suite in the background whenever Claude writes a file, then reports the results back to Claude when the tests finish. Save this script to `.claude/hooks/run-tests-async.sh` in your project and make it executable with `chmod +x`:

```bash theme={null}
#!/bin/bash
# run-tests-async.sh

# Read hook input from stdin
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only run tests for source files
if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.js ]]; then
  exit 0
fi

# Run tests and report results to Claude via additionalContext
RESULT=$(npm test 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  MSG="Tests passed after editing $FILE_PATH"
else
  MSG="Tests failed after editing $FILE_PATH: $RESULT"
fi
jq -nc --arg msg "$MSG" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $msg}}'
```

Then add this configuration to `.claude/settings.json` in your project root. The `async: true` flag lets Claude keep working while tests run:

```json theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/run-tests-async.sh",
            "args": [],
            "async": true
          }
        ]
      }
    ]
  }
}
```

### Limitations

Async hooks have additional constraints compared to synchronous hooks:

* Hook output is delivered on the next conversation turn. If the session is idle, the response waits until the next user interaction. Exception: an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle.
* Each execution creates a separate background process.
* An async `SessionStart` hook runs every time the event fires. Claude Code skips the hook's output when the `additionalContext` and `systemMessage` text matches what Claude last received from that hook, unless a synchronous `SessionStart` hook has added other text since. Claude Code delivers the text when it changes, and again the next time the hook runs after a compaction or `/clear`. Before v2.1.295, Claude Code added the same text to the conversation again on every resume.

## Security considerations

### Disclaimer

> [!WARNING]
>
> Command hooks execute shell commands with your full user permissions. They can modify, delete, or access any files your user account can access. Review and test all hook commands before adding them to your configuration.

### Workspace trust

Claude Code checks workspace trust before it runs any hook from a settings file. What counts as trusted depends on the session type:

* **Interactive session**: Claude Code holds back hooks from every settings file, including your own `~/.claude/settings.json`, until you accept the [workspace trust dialog](https://code.claude.com/docs/en/permissions.md#project-allow-rules-and-workspace-trust) for the folder, or for a parent directory whose trust extends to it
* **`-p` or SDK session**: Claude Code never shows the dialog and treats the folder as trusted, so hooks committed in a repository's `.claude/settings.json` run in a folder you've never trusted

Before you script `claude -p` over a repository you didn't write, review its `.claude/` settings files, start with [`--bare`](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode), or [turn hooks off for that run](#disable-or-remove-hooks) with `--settings '{"disableAllHooks": true}'`. Frontmatter hooks in a project subagent follow a stricter rule than settings-file hooks. [What runs before you trust a folder](https://code.claude.com/docs/en/permissions.md#what-runs-before-you-trust-a-folder) lists each kind of repository content by session type.

### Security best practices

Keep these practices in mind when writing hooks:

* **Validate and sanitize inputs**: never trust input data blindly
* **Always quote shell variables**: use `"$VAR"` not `$VAR`
* **Block path traversal**: check for `..` in file paths
* **Use absolute paths**: specify full paths for scripts. In exec form, use `${CLAUDE_PROJECT_DIR}` and the path needs no quoting. In shell form, wrap it in double quotes
* **Skip sensitive files**: avoid `.env`, `.git/`, keys, etc.

## Windows PowerShell tool

On Windows, you can run individual hooks in PowerShell by setting `"shell": "powershell"` on a command hook. Claude Code auto-detects `pwsh.exe`, the PowerShell 7 and later executable, and falls back to `powershell.exe` for Windows PowerShell 5.1.

```json theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": "Write-Host 'File written'"
          }
        ]
      }
    ]
  }
}
```

### Reference scripts by path in PowerShell hooks

To reference the project root from a PowerShell shell-form command, write `${CLAUDE_PROJECT_DIR}` or `$env:CLAUDE_PROJECT_DIR`. Claude Code rewrites the `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, and `${CLAUDE_PLUGIN_DATA}` placeholders in a PowerShell shell-form command to PowerShell's `${env:NAME}` form, whether the hook is defined in `settings.json`, a plugin, or a skill. PowerShell then resolves the value from the exported environment after parsing, so the placeholder works inside double-quoted strings but not inside single-quoted strings, where PowerShell never expands variables.

Don't write the bare `$CLAUDE_PROJECT_DIR` spelling in a PowerShell hook. PowerShell parses it as an undefined local variable and resolves it to `$null`, which leaves the script path without its project-root prefix. Claude Code doesn't rewrite that form; it logs a warning in the [debug log](#debug-hooks) instead.

The example below shows a `settings.json` hook that runs a project script with the `$env:` form:

```json theme={null}
{
  "type": "command",
  "shell": "powershell",
  "command": "& \"$env:CLAUDE_PROJECT_DIR\\.claude\\hooks\\check.ps1\""
}
```

## Debug hooks

Hook execution details are written to the debug log file. Start Claude Code with `claude --debug-file <path>` to write the log to a known location, or run `claude --debug` and read the log at `~/.claude/debug/<session-id>.txt`. The `--debug` flag doesn't print to the terminal.

For example, a `PostToolUse` hook on `Write` whose command prints `hook-ran` produces entries like:

```text theme={null}
2026-07-19T02:03:24.382Z [DEBUG] Hook output does not start with {, treating as plain text
2026-07-19T02:03:24.382Z [DEBUG] "Hook PostToolUse:Write (PostToolUse) success:\nhook-ran"
```

To find a slow hook, search the log for `Hooks:` lines that end in a duration. In Claude Code v2.1.296 or later, each command hook on a tool event, `UserPromptSubmit`, `SessionStart`, `Stop`, and several other events leaves one when it finishes, whatever it printed. The line gives the event name, joined by a colon to the tool name or other value the hook matched on, then the hook's command in brackets, the plugin it came from if any, how the run ended, and how long it took, as in `Hooks: PostToolUse:Write [.claude/hooks/log-write.sh] finished with status 0 (31ms)`. A run can also end as `timed out after <N>ms`, `cancelled`, `moved to the background`, or `failed to start`. On some events, such as `Notification`, `SessionEnd`, and `PreCompact`, a command hook leaves a `completed with status` line without a duration instead.

For more granular hook matching details, set `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` to see additional log lines such as hook matcher counts and query matching.

For troubleshooting common issues like hooks not firing, Stop hooks that keep blocking, or configuration errors, see [Limitations and troubleshooting](https://code.claude.com/docs/en/hooks-guide.md#limitations-and-troubleshooting) in the guide. For a broader diagnostic walkthrough covering `/context`, `/doctor`, and settings precedence, see [Debug your config](https://code.claude.com/docs/en/debug-your-config.md).
