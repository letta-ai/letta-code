> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Configure permissions

> Control how your agent uses tools with permission modes, hooks, and declarative allow/deny rules.

The Claude Agent SDK provides permission controls to manage how Claude uses tools. Use permission modes and rules to define what's allowed automatically, and the [`canUseTool` callback](https://code.claude.com/docs/en/agent-sdk/user-input) to handle everything else at runtime.

## How permissions are evaluated

> [!NOTE]
>
> If you load a plugin that contains a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md), see [where a mod's decisions fit among rules and hooks](https://code.claude.com/docs/en/permissions.md#precedence-among-rules-hooks-and-mods).

When Claude requests a tool, the SDK checks permissions in this order:

**1. Hooks**

Run [hooks](https://code.claude.com/docs/en/agent-sdk/hooks.md) first. A hook can deny the call outright or pass it on. A hook that returns `allow` doesn't skip the deny and ask rules below, which are evaluated regardless of the hook result.

A `PreToolUse` hook that returns `allow` also can't approve an `rm` or `rmdir` command whose target Claude Code recognizes as a [critical path](https://code.claude.com/docs/en/permission-modes.md#critical-paths), such as `rm -rf ~`. For what that `allow` does in plan mode, see [Hook approvals in plan mode](https://code.claude.com/docs/en/permissions.md#hook-approvals-in-plan-mode).

**2. Deny rules**

If a deny rule from `disallowed_tools` or [settings.json](https://code.claude.com/docs/en/settings-reference.md#permission-settings) matches, the call is denied and [`canUseTool`](https://code.claude.com/docs/en/agent-sdk/user-input) isn't called, even in [`bypassPermissions`](#bypass-permissions-mode-bypasspermissions) mode and even when a hook returned `allow`.

In the TypeScript SDK, if you set the `permission_policy` of a [custom tool](https://code.claude.com/docs/en/agent-sdk/custom-tools.md#require-approval-for-specific-tools) to [`always_deny`](https://code.claude.com/docs/en/agent-sdk/typescript#mcpservertoolpolicy), a call to that tool is denied at this step.

**3. Ask rules**

Check `ask` rules from [settings.json](https://code.claude.com/docs/en/settings-reference.md#permission-settings). If an ask rule matches, the call falls through to your [`canUseTool` callback](https://code.claude.com/docs/en/agent-sdk/user-input) for confirmation, even in `bypassPermissions` mode.

Tools that require user interaction behave the same way: `AskUserQuestion` and MCP tools whose server sets [`_meta["anthropic/requiresUserInteraction"]`](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool) always fall through to the callback, even when an allow rule matches. In `dontAsk` mode both cases are denied instead, because that mode never prompts. The MCP annotation requires Claude Code v2.1.199 or later.

[claude.ai connector](https://code.claude.com/docs/en/mcp.md#organization-controls-on-connector-tools) tools your organization has set to `ask` also leave the flow at this step. Every call falls through to the callback, even in `bypassPermissions` mode and even when an allow rule matches. The callback receives the reason `Your organization requires approval for this tool`. In `dontAsk` mode the call is denied instead, because that mode never prompts.

In the TypeScript SDK, if you set a custom tool's `permission_policy` to [`always_ask`](https://code.claude.com/docs/en/agent-sdk/custom-tools#require-approval-for-specific-tools), no allow rule approves its calls, not even an `allowedTools` entry. In `dontAsk` mode Claude Code denies those calls, and in `auto`, `plan`, or `bypassPermissions` mode it [can approve them](https://code.claude.com/docs/en/agent-sdk/typescript.md#permission-modes-that-can-approve-an-always_ask-call) before your callback runs.

**4. Permission mode**

Apply the active [permission mode](#permission-modes):

* In `bypassPermissions` mode, Claude Code approves everything that reaches this step except recognized [critical-path removals](https://code.claude.com/docs/en/permission-modes.md#critical-paths) and Bash commands flagged [`Dangerous rm operation not ruled out`](https://code.claude.com/docs/en/permission-modes#dangerous-rm-operation-not-ruled-out), which fall through instead.
  * To run those removals with no prompt, see [Turn off the critical-path removal prompt](https://code.claude.com/docs/en/permission-modes.md#turn-off-the-critical-path-removal-prompt-in-bypasspermissions-mode).
* In `acceptEdits` mode, Claude Code approves the file operations listed under [Accept edits mode](#accept-edits-mode-acceptedits).
* In `plan` mode, Claude Code sends file-edit tools to your `canUseTool` callback regardless of allow rules.
* In other modes, the request falls through.

**5. Allow rules**

Check `allow` rules (from `allowed_tools` and settings.json). If a rule matches, the tool is approved. A call the tool approves on its own is resolved at this step too, with no rule needed: for example a file read inside your working directories or a [read-only Bash command](https://code.claude.com/docs/en/permissions.md#read-only-commands).

Recognized [critical-path removals](https://code.claude.com/docs/en/permission-modes.md#critical-paths) aren't approved by an allow rule, and commands flagged `Dangerous rm operation not ruled out` aren't approved by a `Bash` or `Bash(*)` rule. Whether they then reach your callback depends on the permission mode: in an Agent SDK session in `auto` mode, for example, Claude Code denies them by default without calling it. The [Critical paths mode table](https://code.claude.com/docs/en/permission-modes.md#critical-path-removals-in-each-permission-mode) lists what each mode does with them.

An allow rule doesn't approve a read from a [network path](https://code.claude.com/docs/en/permissions.md#network-paths).

**6. canUseTool callback**

If not resolved by any of the above, call your [`canUseTool` callback](https://code.claude.com/docs/en/agent-sdk/user-input) for a decision. In `dontAsk` mode, this step is skipped and the tool is denied, though a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) you installed can still approve [some such calls](https://code.claude.com/docs/en/permissions.md#precedence-among-rules-hooks-and-mods).

In the TypeScript SDK, if you set [`permissionPrompts: 'none'`](https://code.claude.com/docs/en/agent-sdk/typescript#options), your callback isn't called at this step. A [`PermissionRequest` hook](https://code.claude.com/docs/en/hooks#permissionrequest) still gets a chance to decide, and if it doesn't, Claude Code denies the call. The option requires Claude Code v2.1.259 or later.

![Diagram of the six-step permission evaluation flow matching the steps above: a tool request passes through hooks, deny rules, ask rules, permission mode, allow rules, and canUseTool. Hooks, deny rules, and canUseTool can route down to Blocked; permission mode bypass, allow rules, and canUseTool can route up to Execute; ask rules route to canUseTool.](https://mintcdn.com/claude-code/jYgs7qigNjO1Badj/images/agent-sdk/permissions-flow.svg?fit=max\&auto=format\&n=jYgs7qigNjO1Badj\&q=85\&s=c771ad9085b1277d3708027a49c744bc)

If you pass a `canUseTool` callback in a configuration where the TypeScript SDK expects the evaluation order to auto-approve calls before the callback is consulted, the SDK emits a Node.js process warning once when the query is constructed. The warning's code is `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. Two configurations trigger it:

* `permissionMode: 'bypassPermissions'`: the warning text starts with `canUseTool will not be invoked: permissionMode 'bypassPermissions'`. Tool calls are approved before `canUseTool` is consulted, so your callback runs for only a few calls, such as the calls listed under [Bypass permissions mode](#bypass-permissions-mode-bypasspermissions). To check the approved calls too, put your callback's checks in a [`PreToolUse` hook](https://code.claude.com/docs/en/agent-sdk/hooks)
* An `allowedTools` entry that is only a tool name, such as `"Read"`: the warning lists each such entry after `canUseTool will not be invoked for:`. Calls to a listed tool are approved before `canUseTool` is consulted, apart from the [calls an allow rule never approves](#calls-an-allow-rule-never-approves). To have your callback run for a listed tool's calls that need approval, remove that tool's entry from `allowedTools`

Entries with a specifier such as `Bash(ls *)` and the `acceptEdits` mode don't trigger it, and allow rules coming from settings files aren't visible to the check.

The warning doesn't block any call or change any option. If your callback already receives every call you want to check, leave your configuration as it is. To log the warning, listen with `process.on('warning', ...)` and match the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` code.

This page focuses on **allow and deny rules** and **permission modes**. For the other steps:

* **Hooks:** run custom code to allow, deny, or modify tool requests. See [Control execution with hooks](https://code.claude.com/docs/en/agent-sdk/hooks.md).
* **canUseTool callback:** prompt users for approval at runtime, when no earlier step resolves the call. See [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input.md).

## Allow and deny rules

`allowed_tools` and `disallowed_tools` (TypeScript: `allowedTools` / `disallowedTools`) add entries to the allow and deny rule lists in the evaluation flow above. If you name one of the [task-tracking tools](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md#model-availability) in `allowed_tools`, Claude Code also opts the session in. Any other tool not listed in `allowed_tools` is still available to Claude, and a call to it that needs approval falls through to the permission mode. Deny rules behave differently depending on whether they name a tool or scope a pattern within one.

| Option | Effect |
| :- | :- |
| `allowed_tools=["Read", "Grep"]` | `Read` and `Grep` are auto-approved, apart from [reads from network paths](https://code.claude.com/docs/en/permissions.md#network-paths). Other tools not listed here still exist, and calls to them that need approval fall through to the permission mode and `canUseTool`. |
| `disallowed_tools=["Bash"]` | The `Bash` tool definition is removed from the request. Claude does not see the tool and cannot attempt it. |
| `disallowed_tools=["Bash(rm *)"]` | `Bash` stays available. Calls matching `rm *` [as written](https://code.claude.com/docs/en/permissions.md#bash-rule-limits) are denied in every permission mode, including `bypassPermissions`. Other `Bash` calls, including `/bin/rm`, fall through to the permission mode. |
| `disallowed_tools=["*"]` | Every tool definition is removed from the request. Tool-name globs are supported in deny rules: `"*"` matches every tool and `"mcp__*"` matches every MCP tool across all servers. |

Allow rules accept tool-name globs only after a literal `mcp__<server>__` prefix. The server segment must be glob-free so the rule names a specific server you configured: `mcp__puppeteer__*` matches every tool from the `puppeteer` server, and `mcp__github__get_*` matches its `get_` tools. An unanchored entry like `allowed_tools=["*"]` or `allowed_tools=["mcp__*"]` is ignored and doesn't auto-approve anything.

Scoped rules for `Read` and `Edit` take a path pattern. `Edit(path)` rules govern all built-in tools that write files, including `Write` and `NotebookEdit`; a `Write(path)` rule is never matched by the file permission checks.

Use `//path` for an absolute filesystem path: a deny rule of `Edit(//secrets/**)` blocks writes anywhere under `/secrets` on disk. With a single leading slash, `Edit(/secrets/**)` anchors at the rule's source instead. For rules passed through `allowed_tools` or `disallowed_tools`, that means the session's working directory, so the rule doesn't block `/secrets` on disk. See [Read and Edit rules](https://code.claude.com/docs/en/permissions.md#read-and-edit) for the four anchor forms and how rules from settings files resolve.

> [!WARNING]
>
> **Auto-approved tools never reach `canUseTool`.** A tool call approved at any earlier step, by `acceptEdits` or `bypassPermissions`, or by an allow rule, skips your `canUseTool` callback, so permission checks you put there are silently bypassed for that tool.
>
> If calls to a tool in `allowed_tools` still reach your `canUseTool` callback, or are denied in `dontAsk` mode, check whether they're [reads from network paths](https://code.claude.com/docs/en/permissions.md#network-paths) or among the following calls. No allow rule approves these calls. In `dontAsk` mode, which never prompts, Claude Code denies them without calling `canUseTool`, and in the other permission modes you handle them as each item says:
>
> * `AskUserQuestion`, MCP tools marked [`_meta["anthropic/requiresUserInteraction"]`](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool), and connector tools [your organization set to `ask`](https://code.claude.com/docs/en/mcp#organization-controls-on-connector-tools): answer them in the callback. [Handle clarifying questions](https://code.claude.com/docs/en/agent-sdk/user-input.md#handle-clarifying-questions) shows how to answer `AskUserQuestion`, and a connector call arrives with the reason `Your organization requires approval for this tool`
>
> * Custom tools your application marks [`always_ask`](https://code.claude.com/docs/en/agent-sdk/custom-tools#require-approval-for-specific-tools): decide the call in the callback. To stop these calls arriving, [change the policy mid-session](https://code.claude.com/docs/en/agent-sdk/typescript.md#mcpsdkserverconfigwithinstance). In `auto`, `plan`, and `bypassPermissions` mode the call can instead be approved before the callback, in the cases listed under [Permission modes that can approve an `always_ask` call](https://code.claude.com/docs/en/agent-sdk/typescript#permission-modes-that-can-approve-an-always_ask-call)
>
> * Recognized `rm` and `rmdir` [critical-path removals](https://code.claude.com/docs/en/permission-modes.md#critical-paths): in `default`, `acceptEdits`, and `bypassPermissions` mode, allow or deny the removal in the callback, where [`decisionReason`](https://code.claude.com/docs/en/agent-sdk/typescript#canusetool) starts with `Dangerous rm`. For `auto` and `plan` mode, see [Critical-path removals in each permission mode](https://code.claude.com/docs/en/permission-modes.md#critical-path-removals-in-each-permission-mode). The check that recognizes these removals [can miss some commands](https://code.claude.com/docs/en/permission-modes.md#critical-paths)
>
> * **Bare name**: an entry like `Read` or `mcp__github__get_issue` auto-approves every call to that tool apart from the [actions no mode auto-approves](https://code.claude.com/docs/en/permission-modes.md#actions-no-mode-auto-approves) and [reads from network paths](https://code.claude.com/docs/en/permissions.md#network-paths).
>
> * **Scoped rule**: an entry like `Bash(npm test *)` auto-approves only matching calls, and other `Bash` calls that need approval still fall through to the callback.
>
> For checks that must run on every tool call, use a [`PreToolUse` hook](https://code.claude.com/docs/en/agent-sdk/hooks): hooks run before every other step, and a hook deny applies even in `bypassPermissions` mode.

For a locked-down agent, pair `allowedTools` with `permissionMode: "dontAsk"`:

```typescript theme={null}
const options = {
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk"
};
```

The listed `Read`, `Glob`, and `Grep` calls are approved, apart from the [actions no mode auto-approves](https://code.claude.com/docs/en/permission-modes.md#actions-no-mode-auto-approves) and [reads from network paths](https://code.claude.com/docs/en/permissions.md#network-paths). Every other call that would prompt is denied instead, though a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) you installed can still approve [some of those calls](https://code.claude.com/docs/en/permissions.md#precedence-among-rules-hooks-and-mods).

Calls that need no approval in `default` mode run whether or not you list them. These include [read-only Bash commands](https://code.claude.com/docs/en/permissions.md#read-only-commands), tools like `Agent` that don't ask before running, and file reads inside your working directories. To hide a built-in tool from Claude entirely rather than deny its calls, add its bare name to `disallowedTools`.

> [!WARNING]
>
> **`allowed_tools` does not constrain `bypassPermissions`.** `allowed_tools` pre-approves the tools you list. Other unlisted tools are not matched by any allow rule and fall through to the permission mode, where `bypassPermissions` approves them. Setting `allowed_tools=["Read"]` alongside `permission_mode="bypassPermissions"` still approves every tool, including `Bash`, `Write`, and `Edit`. If you need `bypassPermissions` but want specific tools blocked, use `disallowed_tools`.

You can also configure allow, deny, and ask rules declaratively in `.claude/settings.json`. These rules are read when the `project` setting source is enabled, which it is for default `query()` options. If you set `setting_sources` (TypeScript: `settingSources`) explicitly, include `"project"` for them to apply. See [Permission settings](https://code.claude.com/docs/en/settings-reference.md#permission-settings) for the rule syntax.

## Permission modes

Permission modes provide global control over how Claude uses tools. You can set the permission mode when calling `query()` or change it dynamically during streaming sessions.

With Claude Code v2.1.302 or later, your app starts in `default` mode unless you set a permission mode or it gets one from [`permissions.defaultMode`](https://code.claude.com/docs/en/settings-reference#permissions-defaultmode) in its settings files. In `default` mode, Claude Code denies any tool call needing approval unless you approve it through an allow rule, hook, `canUseTool` callback, or permission prompt tool. If tool calls are denied, see [Tool calls denied in `claude -p` and Agent SDK runs](https://code.claude.com/docs/en/permission-modes#which-mode-a-non-interactive-run-starts-in).

### Available modes

The SDK supports these permission modes:

| Mode | Description | Tool behavior |
| :- | :- | :- |
| `default` | Standard permission behavior | No mode-based auto-approvals; calls that need approval and match no allow rule trigger your `canUseTool` callback |
| `dontAsk` | Deny instead of prompting | Any call that would otherwise prompt is denied without calling `canUseTool`, though a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) you installed can still approve [some of those calls](https://code.claude.com/docs/en/permissions.md#precedence-among-rules-hooks-and-mods). Calls approved by `allowed_tools` or `settings.json` allow rules run, and so do calls that need no approval in `default` mode. Some calls, such as [reads from network paths](https://code.claude.com/docs/en/permissions.md#network-paths), are denied even when `allowed_tools` or an allow rule matches them. For the list, see [Don't ask mode](#don’t-ask-mode-dontask) |
| `acceptEdits` | Auto-accept file edits | File edits and [filesystem operations](#accept-edits-mode-acceptedits) (`mkdir`, `rm`, `mv`, etc.) are automatically approved |
| `bypassPermissions` | Bypass permission checks | Tools run without permission prompts, except for the [actions no mode auto-approves](https://code.claude.com/docs/en/permission-modes.md#actions-no-mode-auto-approves) and, outside a [cloud session](https://code.claude.com/docs/en/claude-code-on-the-web.md), custom tools your application [marks `always_ask`](https://code.claude.com/docs/en/agent-sdk/custom-tools#require-approval-for-specific-tools). Use with caution |
| `plan` | Planning mode | Claude explores and plans without editing your source files; file edits are never auto-approved and prompt through your `canUseTool` callback |
| `auto` | Model-classified approvals | A model classifier reviews actions such as shell commands and network requests, allowing or blocking each one it reviews. See [Auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) for availability and the decision order |

> [!WARNING]
>
> **Subagent inheritance:** If your main session is in [plan mode](https://code.claude.com/docs/en/permission-modes.md#analyze-before-you-edit-with-plan-mode), a subagent whose [`AgentDefinition`](https://code.claude.com/docs/en/agent-sdk/typescript#agentdefinition) sets `permissionMode: "acceptEdits"` still runs in plan mode. That subagent's `Edit` and `Write` calls on your source files still go to your `canUseTool` callback. Plan mode holds for the subagents you define too, so that handing work to one doesn't get around reviewing the plan first.
>
> The subagent inherits `plan`, `acceptEdits`, `auto`, or `bypassPermissions` from the main session, and under a `default`- or `dontAsk`-mode main session it runs in the mode you set. Even then, Claude Code never applies a `"bypassPermissions"` value, and applies an `"auto"` value only when [auto mode is available](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) to that subagent. The `bypassPermissions` exception requires Claude Code v2.1.267 or later.
>
> Subagents may have different system prompts and less constrained behavior than your main agent, so inheriting `bypassPermissions` grants them full, autonomous system access. The [actions no mode auto-approves](https://code.claude.com/docs/en/permission-modes.md#actions-no-mode-auto-approves) still apply.

### Set permission mode

You can set the permission mode once when starting a query, or change it dynamically while the session is active.

**At query time**

Pass `permission_mode` (Python) or `permissionMode` (TypeScript) when creating a query.

```python Python theme={null}
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions


async def main():
    async for message in query(
        prompt="Help me refactor this code",
        options=ClaudeAgentOptions(
            permission_mode="default",  # Set the mode here
        ),
    ):
        if hasattr(message, "result"):
            print(message.result)


asyncio.run(main())
```

```typescript TypeScript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  for await (const message of query({
    prompt: "Help me refactor this code",
    options: {
      permissionMode: "default" // Set the mode here
    }
  })) {
    if ("result" in message) {
      console.log(message.result);
    }
  }
}

main();
```

**During streaming**

Call `set_permission_mode()` (Python) or `setPermissionMode()` (TypeScript) to change the mode mid-session. The new mode takes effect immediately for all subsequent tool requests. This lets you start restrictive and loosen permissions as trust builds, for example switching to `acceptEdits` after reviewing Claude's initial approach.

```python Python theme={null}
import asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions


async def main():
    async with ClaudeSDKClient(
        options=ClaudeAgentOptions(
            permission_mode="default",  # Start in default mode
        )
    ) as client:
        await client.query("Help me refactor this code")

        # Change mode dynamically mid-session
        await client.set_permission_mode("acceptEdits")

        # Process messages with the new permission mode
        async for message in client.receive_response():
            if hasattr(message, "result"):
                print(message.result)


asyncio.run(main())
```

```typescript TypeScript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  const q = query({
    prompt: "Help me refactor this code",
    options: {
      permissionMode: "default" // Start in default mode
    }
  });

  // Change mode dynamically mid-session
  await q.setPermissionMode("acceptEdits");

  // Process messages with the new permission mode
  for await (const message of q) {
    if ("result" in message) {
      console.log(message.result);
    }
  }
}

main();
```

### Mode details

#### Accept edits mode (`acceptEdits`)

Auto-approves file operations so Claude can edit code without prompting. Other tools (like Bash commands that aren't filesystem operations) still require normal permissions.

**Auto-approved operations:**

* File edits (Edit, Write tools)
* Filesystem commands: `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`

Both apply only to paths inside the working directory or `additionalDirectories`. In `acceptEdits` mode, Claude Code doesn't auto-approve the request when Claude:

* Works on a path outside that scope
* Writes to a protected path
* Removes a path that Claude Code recognizes as a [critical path](https://code.claude.com/docs/en/permission-modes.md#critical-paths) with `rm` or `rmdir`
* Runs [`touch`](https://code.claude.com/docs/en/permission-modes#auto-approve-file-edits-with-acceptedits-mode) with, for example, an option, a glob, or a `timeout 5` or `LANG=C` prefix

**Use when:** you trust Claude's edits and want faster iteration, such as during prototyping or when working in an isolated directory.

#### Don't ask mode (`dontAsk`)

Converts any permission prompt into a denial, without calling `canUseTool`, though a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) you installed can still approve [some of those calls](https://code.claude.com/docs/en/permissions.md#precedence-among-rules-hooks-and-mods). Tools pre-approved by `allowed_tools`, `settings.json` allow rules, or a hook run as normal. Calls that need no approval in `default` mode also run as normal, such as file reads inside your working directories and calls to `Agent`.

These calls are denied even when an allow rule matches:

* Connector tools [your organization set to `ask`](https://code.claude.com/docs/en/mcp#organization-controls-on-connector-tools)
* Tools that require user interaction, such as `AskUserQuestion` and MCP tools whose server sets [`_meta["anthropic/requiresUserInteraction"]`](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool)
* Custom tools whose `permission_policy` your application sets to [`always_ask`](https://code.claude.com/docs/en/agent-sdk/custom-tools#require-approval-for-specific-tools)
* [Reads from network paths](https://code.claude.com/docs/en/permissions.md#network-paths)
* Recognized [critical-path removals](https://code.claude.com/docs/en/permission-modes.md#critical-paths)

If your `PreToolUse` hook returns `allow` for a recognized critical-path removal, a read from a network path, or a call to a tool marked `always_ask`, the call is still denied. The check that recognizes these removals [can miss some commands](https://code.claude.com/docs/en/permission-modes.md#critical-paths).

**Use when:** you want a fixed, explicit tool surface for a headless agent and prefer a hard deny over silent reliance on `canUseTool` being absent.

#### Bypass permissions mode (`bypassPermissions`)

Auto-approves tool uses without prompting, except the [actions no mode auto-approves](https://code.claude.com/docs/en/permission-modes.md#actions-no-mode-auto-approves). Hooks still execute and can block operations if needed. On Linux and macOS, Claude Code refuses to start in this mode as root or under `sudo` outside a [recognized sandbox](https://code.claude.com/docs/en/permission-modes.md#skip-all-checks-with-bypasspermissions-mode), and the query fails before the first turn.

> [!WARNING]
>
> Use with extreme caution. Claude has full system access in this mode. Only use in controlled environments where you trust all possible operations.
>
> `allowed_tools` does not constrain this mode. Every tool is approved, not just the ones you listed. These controls still apply:
>
> * Deny rules, explicit `ask` rules, and hooks are evaluated before the mode check and can still block a tool.
> * Connector tools [your organization set to `ask`](https://code.claude.com/docs/en/mcp#organization-controls-on-connector-tools), tools that require user interaction, and recognized [critical-path removals](https://code.claude.com/docs/en/permission-modes.md#critical-paths) still fall through to your `canUseTool` callback. The check that recognizes these removals [can miss some commands](https://code.claude.com/docs/en/permission-modes.md#critical-paths), and you can [turn off the critical-path removal prompt](https://code.claude.com/docs/en/permission-modes.md#turn-off-the-critical-path-removal-prompt-in-bypasspermissions-mode). Outside a [cloud session](https://code.claude.com/docs/en/claude-code-on-the-web.md), calls to custom tools your application [marks `always_ask`](https://code.claude.com/docs/en/agent-sdk/custom-tools#require-approval-for-specific-tools) fall through to the callback too.
> * The [cross-session messaging safeguards](https://code.claude.com/docs/en/permission-modes.md#skip-all-checks-with-bypasspermissions-mode) still apply.

#### Plan mode (`plan`)

Claude explores the codebase and produces a plan without editing your source files. File edits are never auto-approved in plan mode, even when an allow rule matches or a `PreToolUse` hook returns `allow`. They prompt through your `canUseTool` callback instead.

While auto mode is available to the session, commands Claude runs during planning don't reach your callback by default, because the classifier model that [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) uses [reviews them instead](https://code.claude.com/docs/en/permission-modes.md#analyze-before-you-edit-with-plan-mode). With that review on, the classifier can also approve read-only calls that would otherwise reach your callback, such as a `WebFetch` call with no allow rule.

> [!NOTE]
>
> In the TypeScript SDK, if you set `allowDangerouslySkipPermissions: true` alongside `permissionMode: 'plan'`, file edits still reach your `canUseTool` callback. To switch a session that starts in plan mode to `bypassPermissions` later with `setPermissionMode()`, you need `allowDangerouslySkipPermissions` set from the start.

Claude may use `AskUserQuestion` to clarify requirements before finalizing the plan. See [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input.md#handle-clarifying-questions) for handling these prompts.

**Use when:** you want Claude to propose changes without executing them, such as during code review or when you need to approve changes before they're made.

#### Auto mode (`auto`)

A classifier model reviews actions such as shell commands and network requests before they run, and allows or blocks each one it reviews. For the models and providers auto mode requires and the order it evaluates actions in, see [Eliminate permission prompts with auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode).

If you switch a session that's in auto mode to a model that auto mode doesn't support, using [`set_model()`](https://code.claude.com/docs/en/agent-sdk/python#claudesdkclient), [`setModel()`](https://code.claude.com/docs/en/agent-sdk/typescript#query-object), or [`applyFlagSettings()`](https://code.claude.com/docs/en/agent-sdk/typescript#applyflagsettings), the session changes to `default` mode:

* **What you see**: a `system` message with subtype `status` and `permissionMode` set to `"default"`, which the TypeScript SDK types as [`SDKStatusMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkstatusmessage). From then on, calls that need approval and match no allow rule reach your `canUseTool` callback.
* **To return to auto mode**: switch to a supported model, then call `set_permission_mode("auto")` or `setPermissionMode("auto")`. If you switch the model back without making that call, the session stays in `default` mode. While the unsupported model is active, the call fails with `Cannot set permission mode to auto: auto mode unavailable for this model`.

The change to `default` mode after a `set_model()`, `setModel()`, or `applyFlagSettings()` call requires Claude Code v2.1.299 or later.

## Related resources

For the other steps in the permission evaluation flow:

* [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input.md): interactive approval prompts and clarifying questions
* [Hooks guide](https://code.claude.com/docs/en/agent-sdk/hooks.md): run custom code at key points in the agent lifecycle
* [Permission rules](https://code.claude.com/docs/en/settings-reference.md#permission-settings): declarative allow/deny rules in `settings.json`
