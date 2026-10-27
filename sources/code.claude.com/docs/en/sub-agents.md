> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Create custom subagents

> Create and use specialized AI subagents in Claude Code for task-specific workflows and improved context management.

Subagents are specialized AI assistants that handle specific types of tasks. Use one when a side task would flood your main conversation with search results, logs, or file contents you won't reference again: the subagent does that work in its own context and returns only the summary. Define a custom subagent when you keep spawning the same kind of worker with the same instructions.

Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions. It also sends its own requests, which count toward the same [usage limits](https://code.claude.com/docs/en/costs.md#plan-usage-breakdown) as your main conversation. When Claude encounters a task that matches a subagent's description, it delegates to that subagent, which works independently and returns results. To see the context savings in practice, the [context window visualization](https://code.claude.com/docs/en/context-window.md) walks through a session where a subagent handles research in its own separate window.

> [!NOTE]
>
> Subagents work within a single session. To run many independent sessions in parallel and monitor them from one place, see [background agents](https://code.claude.com/docs/en/agent-view.md). For separate sessions that pass messages to each other, see [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md). For a coordinated team of sessions Claude spawns and supervises, see [agent teams](https://code.claude.com/docs/en/agent-teams.md).

Subagents help you:

* **Preserve context** by keeping exploration and implementation out of your main conversation
* **Enforce constraints** by limiting which tools a subagent can use
* **Reuse configurations** across projects with user-level subagents
* **Specialize behavior** with focused system prompts for specific domains
* **Control costs** by routing tasks to faster, lower-cost models like Haiku

Claude uses each subagent's description to decide when to delegate tasks. When you create a subagent, write a clear description so Claude knows when to use it.

Those descriptions take up context, so keep them short. When the combined descriptions of your subagents, except the built-in ones, exceed 15,000 tokens, Claude Code shows a [warning at startup with the total token count](https://code.claude.com/docs/en/errors.md#agent-descriptions-are-over-the-15000-token-limit). Trim the `description` fields of your subagents, and move detail into each subagent's system prompt, which only loads when that subagent runs.

## Built-in subagents

Claude Code includes built-in subagents that Claude automatically uses when appropriate. Each inherits the parent conversation's permission rules; most run with a restricted tool set.

Explore and Plan start without your CLAUDE.md files and the git status snapshot to keep research fast and inexpensive. Other built-in and [custom subagents](#configure-subagents) load both, unless you set [`omitClaudeMd`](#supported-frontmatter-fields) in a custom subagent's definition to start it without the user, project, and local CLAUDE.md files. For the full breakdown of what reaches a subagent, see [what loads at startup](#what-loads-at-startup).

**Explore**

A fast, read-only agent optimized for searching and analyzing codebases.

* **Model**: the main conversation's model. When the main conversation runs Fable, Explore's model depends on how you connect:
  * With a Claude subscription, an Anthropic Console account, or an [LLM gateway](https://code.claude.com/docs/en/llm-gateway) reached through `ANTHROPIC_BASE_URL`, Explore runs on the Opus model that the [`opus` alias](https://code.claude.com/docs/en/model-config#model-aliases) resolves to.
  * On Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, [Claude Platform on AWS](https://code.claude.com/docs/en/claude-platform-on-aws.md), or a [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway), Explore stays on the main conversation's model.
* **Tools**: read-only tools; Write and Edit are denied
* **Purpose**: file discovery, code search, codebase exploration

A [user or project subagent](#choose-the-subagent-scope) named `Explore` overrides the built-in and keeps its own `model` field, so define one with `model: haiku` to run exploration on a lower-cost model. To force one model onto every subagent, Explore included, see [Run every subagent on one model](#run-every-subagent-on-one-model).

Claude delegates to Explore when it needs to search or understand a codebase without making changes. This keeps exploration results out of your main conversation context.

When invoking Explore, Claude specifies a thoroughness level: **quick** for targeted lookups, **medium** for balanced exploration, or **very thorough** for comprehensive analysis.

**Plan**

A research agent used during [plan mode](https://code.claude.com/docs/en/permission-modes.md#analyze-before-you-edit-with-plan-mode) to gather context before presenting a plan.

* **Model**: inherits from the main conversation, unless you set `CLAUDE_CODE_SUBAGENT_MODEL` and [force it onto every subagent](#run-every-subagent-on-one-model)
* **Tools**: read-only tools; Write and Edit are denied
* **Purpose**: codebase research for planning

When you're in plan mode and Claude needs to understand your codebase, it delegates research to the Plan subagent so that exploration output stays in a separate context window while the main conversation remains read-only.

**General-purpose**

A capable agent for complex, multi-step tasks that require both exploration and action.

* **Model**: the [`CLAUDE_CODE_SUBAGENT_MODEL`](#choose-a-model) model if you set one and nothing assigns a model another way, otherwise the main conversation's model; [Choose a model](#choose-a-model) states the full order, and [Run every subagent on one model](#run-every-subagent-on-one-model) shows how to make the variable override those sources
* **Tools**: every tool [available to subagents](#available-tools)
* **Purpose**: complex research, multi-step operations, code modifications

Claude delegates to general-purpose when the task requires both exploration and modification, complex reasoning to interpret results, or multiple dependent steps.

**Other**

Claude Code includes additional helper agents for specific tasks. These are typically invoked automatically, so you don't need to use them directly.

| Agent | Model | When Claude uses it |
| :- | :- | :- |
| claude | None of its own; follows the [model order](#choose-a-model) when Claude spawns it as a subagent | When a task doesn't fit a more specialized agent. A catch-all with every tool [available to subagents](#available-tools). Also the default agent for a dispatched [background session](https://code.claude.com/docs/en/agent-view.md); [which permission mode it starts in](https://code.claude.com/docs/en/agent-view.md#permission-mode-model-and-effort) depends on how the session was started |
| statusline-setup | Sonnet | When you run `/statusline` to configure your status line |
| claude-code-guide | Haiku | When you ask questions about Claude Code features |

Built-in subagents are registered by default in interactive sessions. To restrict them:

* To block a specific built-in type, add it to `permissions.deny` as shown in [Disable specific subagents](#disable-specific-subagents).
* To prevent Claude from delegating to any subagent, deny the `Agent` tool itself with [`permissions.deny`](https://code.claude.com/docs/en/permissions#tool-specific-permission-rules).
* To remove only the built-in `Explore` and `Plan` subagents, set [`CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1`](https://code.claude.com/docs/en/env-vars). Claude reads and explores files directly instead of delegating to them. Requires Claude Code v2.1.198 or later.
* In [non-interactive mode](https://code.claude.com/docs/en/headless.md) and the [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md), set [`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`](https://code.claude.com/docs/en/env-vars) to remove all built-in types and supply only your own.

An Agent tool call that omits `subagent_type` fails with [`subagent_type is required`](https://code.claude.com/docs/en/errors#subagent-type-is-required) when the session has no `general-purpose` subagent to fall back on.

Beyond these built-in subagents, you can create your own with custom prompts, tool restrictions, permission modes, hooks, and skills. The following sections show how to get started and customize subagents.

## Quickstart: create your first subagent

Subagents are Markdown files with YAML frontmatter. To create one, ask Claude to write it for you, or [write the file yourself](#write-subagent-files).

This walkthrough creates a user-level subagent that reviews code and suggests improvements.

**1. Ask Claude to create the subagent**

In Claude Code, describe the subagent you want and where to save it:

```text wrap theme={null}
Create a personal code-improver subagent in ~/.claude/agents/ that scans
files and suggests improvements for readability, performance, and best
practices. It should explain each issue, show the current code, and
provide an improved version. Make it read-only and have it use Sonnet.
```

Claude writes the file with a `name`, a `description`, a `tools` list, a `model`, and a system prompt.

**2. Review the file**

Open `~/.claude/agents/code-improver.md` and confirm the frontmatter matches what you asked for. The result looks like this:

```markdown theme={null}
---
name: code-improver
description: Scans files and suggests improvements for readability, performance, and best practices. Use after writing or modifying code.
tools: Read, Grep, Glob
model: sonnet
---

You are a code improvement specialist. For each issue you find, explain
the problem, show the current code, and provide an improved version.
```

Because the file lives in `~/.claude/agents/`, the subagent is available in every project on your machine. To scope it to one project instead, move it to that project's `.claude/agents/` directory. [Choose the subagent scope](#choose-the-subagent-scope) compares the two.

**3. Try it out**

Ask Claude to delegate to the new subagent:

```text wrap theme={null}
Use the code-improver agent to suggest improvements in this project
```

Claude delegates to your new subagent, which scans the codebase and returns improvement suggestions. In the transcript, the delegation appears as a tool call row showing the subagent's name followed by a short task description, such as `code-improver(Suggest code improvements)`.

If Claude can't find the new subagent, restart Claude Code and try again. This happens only when `~/.claude/agents/` didn't exist before the session started, because a running session doesn't detect a newly created `agents` directory.

You now have a subagent you can use in any project on your machine to analyze codebases and suggest improvements.

You can also write subagent files by hand, define them via CLI flags, or distribute them through plugins. The following sections cover all configuration options.

> [!NOTE]
>
> Running `/agents` prints a reminder to ask Claude or edit `.claude/agents/` and `~/.claude/agents/` directly.
> On Claude Code v2.1.197 and earlier, `/agents` opens an interactive wizard with a **Running** tab that lists live subagents and a **Library** tab for creating, editing, and deleting them.&#x20;

## Configure subagents

A subagent's file location determines who it's available to, and its frontmatter determines what it can do. This section covers where subagent files live and every field they support.

### Choose the subagent scope

Store subagent files in different locations depending on scope. When multiple subagents share the same name, Claude Code uses the one from the higher-priority location.

| Location | Scope | Priority | How to create |
| :- | :- | :- | :- |
| Managed settings | Organization-wide | 1 (highest) | Deployed via [managed settings](https://code.claude.com/docs/en/settings.md) |
| `--agents` CLI flag | Current session | 2 | Pass JSON when launching Claude Code |
| `.claude/agents/` | Current project | 3 | Ask Claude, or create the file manually |
| `~/.claude/agents/` | All your projects | 4 | Ask Claude, or create the file manually |
| Plugin's `agents/` directory | Where plugin is enabled | 5 (lowest) | Installed with [plugins](https://code.claude.com/docs/en/plugins/overview.md) |

**Project subagents** (`.claude/agents/`) are ideal for subagents specific to a codebase. Check them into version control so your team can use and improve them collaboratively.

Project subagents are discovered by walking up from the current working directory, so every `.claude/agents/` between there and the repository root is scanned. When more than one of these nested directories defines the same `name`, Claude Code uses the definition closest to the working directory.

When you add a directory with `--add-dir` or `/add-dir`, Claude Code also loads its `.claude/agents/` folder, alongside your project subagents. See [Additional directories](https://code.claude.com/docs/en/permissions.md#additional-directories-grant-file-access-not-configuration) for which other configuration types load from `--add-dir`. To share subagents across projects without `--add-dir`, use `~/.claude/agents/` or a [plugin](https://code.claude.com/docs/en/plugins/overview.md).

**User subagents** (`~/.claude/agents/`) are personal subagents available in all your projects.

Claude Code scans `.claude/agents/` and `~/.claude/agents/` recursively, so you can organize definitions into subfolders such as `agents/review/` or `agents/research/`. The subdirectory path doesn't affect how a subagent is identified or invoked, because identity comes only from the `name` frontmatter field.

Keep `name` values unique across the whole tree: if two files under the same `.claude/agents/` directory, including its subfolders, declare the same name, Claude Code loads only one of them, chosen by filesystem read order rather than a documented precedence. Across nested project directories, the definition closest to the working directory wins, as described above. The [`/doctor`](https://code.claude.com/docs/en/commands#all-commands) setup checkup reports files in the same directory that share a name and proposes renaming or removing all but one.

Plugin `agents/` directories are also scanned recursively. Unlike project and user scopes, a subfolder inside a plugin's `agents/` directory becomes part of the [scoped identifier](#invoke-subagents-explicitly): a file at `agents/review/security.md` in plugin `my-plugin` registers as `my-plugin:review:security`.

**CLI-defined subagents** are passed as JSON when launching Claude Code. They exist only for that session and aren't saved to disk, making them useful for quick testing or automation scripts. You can define multiple subagents in a single `--agents` call:

**macOS, Linux, WSL**

```bash theme={null}
claude --agents '{
  "code-reviewer": {
    "description": "Expert code reviewer. Use proactively after code changes.",
    "prompt": "You are a senior code reviewer. Focus on code quality, security, and best practices.",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "sonnet"
  },
  "debugger": {
    "description": "Debugging specialist for errors and test failures.",
    "prompt": "You are an expert debugger. Analyze errors, identify root causes, and provide fixes."
  }
}'
```

**Windows PowerShell**

```powershell theme={null}
claude --agents @'
{
  "code-reviewer": {
    "description": "Expert code reviewer. Use proactively after code changes.",
    "prompt": "You are a senior code reviewer. Focus on code quality, security, and best practices.",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "sonnet"
  },
  "debugger": {
    "description": "Debugging specialist for errors and test failures.",
    "prompt": "You are an expert debugger. Analyze errors, identify root causes, and provide fixes."
  }
}
'@
```

In [non-interactive mode](https://code.claude.com/docs/en/headless.md), `--agents` also accepts the path to a JSON file holding the same object, for definitions too large to pass on the command line. For example, `claude -p --agents ./agents.json "Review my changes"` reads the definitions from that file. In an interactive session, Claude Code refuses a file path. The file form requires Claude Code v2.1.281 or later.

Each top-level key in the JSON is an agent's name, and its value is that agent's definition. Don't start a name with `-`. A definition takes these fields:

* **`prompt`**: the agent's system prompt, equivalent to the markdown body in file-based subagents. `prompt` may be empty. If you select an agent with an empty `prompt` and no `memory` field as the session's agent with `--agent`, the session's system prompt is left unchanged. An empty `prompt` requires Claude Code v2.1.281 or later.
* **[Frontmatter fields](#supported-frontmatter-fields)**: `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `autoCompactWindow`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `omitClaudeMd`, and `isolation`.
* **Ignored fields**: `color` and `experimental` aren't accepted here and are ignored rather than rejected.

For what Claude Code does with a value it can't load, and the flags and environment variable that skip that check, see [`Invalid --agents configuration`](https://code.claude.com/docs/en/errors#invalid-agents-configuration).

**Managed subagents** are deployed by organization administrators. Place markdown files in `.claude/agents/` inside the [managed settings directory](https://code.claude.com/docs/en/managed-settings.md#delivery-mechanisms), using the same frontmatter format as project and user subagents. Managed definitions take precedence over project and user subagents with the same name.

**Plugin subagents** come from [plugins](https://code.claude.com/docs/en/plugins/overview.md) you've installed. They load automatically alongside your custom subagents and appear in the @-mention typeahead under their scoped name. See the [plugin components reference](https://code.claude.com/docs/en/plugins/components.md#agents) for details on creating plugin subagents.

> [!NOTE]
>
> For security reasons, plugin subagents don't support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields. These fields are ignored when loading agents from a plugin. If you need them, copy the agent file into `.claude/agents/` or `~/.claude/agents/`. You can also add rules to [`permissions.allow`](https://code.claude.com/docs/en/settings-reference#permissions-allow) in `settings.json` or `settings.local.json`, but these rules apply to the entire session, not only the plugin subagent.
>
> If you're the plugin's author, ship the hooks in the plugin's [`hooks/hooks.json`](https://code.claude.com/docs/en/plugins/components#hooks) and the MCP servers in its [`.mcp.json`](https://code.claude.com/docs/en/plugins/components#mcp-servers) instead. They apply whenever the plugin is enabled rather than only inside the subagent.

You can also reuse a subagent definition as an [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate: name the subagent type when you ask Claude to spawn the teammate, and Claude Code applies parts of that definition to it. [Use subagent definitions for teammates](https://code.claude.com/docs/en/agent-teams.md#use-subagent-definitions-for-teammates) says which scopes and which parts apply in each display mode.

### Write subagent files

Subagent files use YAML frontmatter for configuration, followed by the system prompt in Markdown:

> [!NOTE]
>
> Claude Code watches `~/.claude/agents/` and `.claude/agents/`. When you add or edit a subagent file on disk, or ask Claude to write one for you, Claude Code detects the change within a few seconds and the next delegation uses the updated definition, with no restart needed.
>
> Three cases still need a restart:
>
> * The watcher covers only directories that existed when the session started, so after creating a scope's first agent file in a new `agents` directory, restart to load it.
> * Claude Code doesn't watch `.claude/agents/` inside directories added with `--add-dir` or `/add-dir`, so after adding or editing a subagent there, restart to load the change.
> * Sessions started with `--disable-slash-commands` don't watch these directories at all.

```markdown .claude/agents/code-reviewer.md theme={null}
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

The frontmatter defines the subagent's metadata and configuration. The body becomes the system prompt that guides the subagent's behavior. Subagents receive only this system prompt plus basic environment details like the working directory, not the Claude Code system prompt.

In [non-interactive mode](https://code.claude.com/docs/en/headless.md), pass [`--append-subagent-system-prompt`](https://code.claude.com/docs/en/cli-reference#cli-flags) to append your text to the end of every subagent's system prompt, nested subagents included, apart from a [forked subagent](#fork-the-current-conversation), which reuses the conversation's own prompt. Requires Claude Code v2.1.205 or later. If your text is too long to pass on the command line, save it to a file and pass the path with `--append-subagent-system-prompt-file` instead. The file flag requires Claude Code v2.1.261 or later.

A subagent starts in the main conversation's current working directory. Within a subagent, `cd` commands don't persist between Bash or PowerShell tool calls and don't affect the main conversation's working directory. To give the subagent an isolated copy of the repository instead, set [`isolation: worktree`](#supported-frontmatter-fields).

A subagent with `isolation: worktree` runs its Bash and PowerShell commands inside its worktree. A command whose working directory resolves to your main checkout instead, for example because the worktree directory was removed while the subagent was running, fails with an error.

This working-directory check covers the whole repository containing the directory you launched Claude Code from. When your session runs in a linked [worktree](https://code.claude.com/docs/en/worktrees.md) of its own, the check also covers the main checkout that worktree is linked from.

For Bash commands, Claude Code also checks the command itself in two ways:

* It blocks a command that redirects git into the main checkout.
* It refuses a command when it can't verify from the command text that any git the command runs stays inside the worktree, for example when the command name is computed at runtime.

The redirect vectors and the shape rules are listed under [How Claude Code enforces isolation](https://code.claude.com/docs/en/worktrees.md#how-claude-code-enforces-isolation). PowerShell commands get only the working-directory check.

[Monitor](https://code.claude.com/docs/en/tools-reference.md#monitor-tool) commands go through the same working-directory and command-content checks as Bash commands.

When the main conversation itself runs isolated in a worktree, Claude Code applies the same checks to the session and to every subagent it spawns, including subagents without `isolation: worktree`; see [How Claude Code enforces isolation](https://code.claude.com/docs/en/worktrees.md#how-claude-code-enforces-isolation).

### Frontmatter reference

Configure a subagent with YAML [frontmatter](https://code.claude.com/docs/en/glossary.md#frontmatter) between `---` markers at the top of its file, and write its system prompt as Markdown after the closing `---`. Only `name` and `description` are required.

Multi-word field names use camelCase, such as `maxTurns` and `disallowedTools`, and must match the table exactly: Claude Code ignores a field it doesn't recognize without reporting an error.

* To find a misspelled field in a subagent that loaded, run [`claude --debug`](https://code.claude.com/docs/en/cli-reference#cli-flags) in your shell and search the debug log at `~/.claude/debug/<session-id>.txt` for `does not recognize or apply`. The debug log names up to five top-level fields in the subagent's file that Claude Code doesn't recognize, with the likely intended name when a supported field is close. Requires Claude Code v2.1.296 or later.
* To find out why a subagent file didn't load, see [Subagent files Claude Code skips](#subagent-files-claude-code-skips).

| Field | Required | Description |
| :- | :- | :- |
| `name` | Yes | Unique identifier of at most 256 characters, such as `code-reviewer` or `reviewer-v2`. [Hooks](https://code.claude.com/docs/en/hooks.md#subagentstart) receive this value as `agent_type`. The filename doesn't have to match. Names can't contain `:`, which is reserved for [plugin-scoped identifiers](https://code.claude.com/docs/en/plugins/overview.md) such as `my-plugin:reviewer` |
| `description` | Yes | When Claude should delegate to this subagent |
| `tools` | No | [Tools](#available-tools) the subagent can use, as a comma-separated string such as `Read, Grep, Bash` or a YAML list. Inherits every tool available to subagents if omitted. If no entry in the list resolves to a tool, the subagent usually [fails to launch](https://code.claude.com/docs/en/errors.md#agent-would-be-spawned-with-zero-tools) with an error naming the entries. To preload Skills into context, use the `skills` field rather than listing `Skill` here |
| `disallowedTools` | No | Tools to deny, removed from inherited or specified list. Same format as `tools`. An entry with a specifier, such as `Bash(git push *)`, still [removes the whole tool](#restrict-which-tools-a-subagent-can-use) |
| `model` | No | [Model](#choose-a-model) to use: `sonnet`, `opus`, `haiku`, `fable`, a full model ID such as `claude-opus-5-5`, or `inherit`. When you omit it, Claude Code picks the model in the [subagent model order](#choose-a-model) |
| `permissionMode` | No | [Permission mode](#permission-modes): `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, or `manual` as an alias for `default`. Ignored for [plugin subagents](#choose-the-subagent-scope) |
| `maxTurns` | No | Maximum number of agentic turns before the subagent stops. When the subagent reaches the limit, Claude Code returns its output marked as partial, and Claude can [resume it](#resume-subagents) to continue. The partial marking requires Claude Code v2.1.246 or later |
| `autoCompactWindow` | No | Lower the [auto-compact window](#subagent-auto-compact-window) for this subagent to a token count from `100000` to `1000000`. Requires Claude Code v2.1.296 or later |
| `skills` | No | [Skills](https://code.claude.com/docs/en/skills.md) to preload into the subagent's context at startup. The full skill content is injected, not only the description. Subagents can still invoke unlisted project, user, and plugin skills through the Skill tool |
| `mcpServers` | No | [MCP servers](https://code.claude.com/docs/en/mcp.md) available to this subagent. Each entry is either a server name referencing an already-configured server (e.g., `"slack"`) or an inline definition with the server name as key and a full [MCP server config](https://code.claude.com/docs/en/mcp.md#installing-mcp-servers) as value. Ignored for [plugin subagents](#choose-the-subagent-scope) |
| `hooks` | No | [Lifecycle hooks](#define-hooks-for-subagents) scoped to this subagent. Ignored for [plugin subagents](#choose-the-subagent-scope) |
| `memory` | No | [Persistent memory scope](#enable-persistent-memory): `user`, `project`, or `local`. Enables cross-session learning |
| `background` | No | Set to `true` to keep this subagent in the background even when Claude asks to wait for it. By default, subagents Claude spawns from the main conversation already [start in the background](#run-subagents-in-foreground-or-background) |
| `omitClaudeMd` | No | Set to `true` to start this subagent without the user, project, and local CLAUDE.md files in its [initial context](#what-loads-at-startup); [managed policy files](https://code.claude.com/docs/en/memory.md#how-claude-md-files-load) still load, except for [managed subagents](#choose-the-subagent-scope). Use it for subagents that take everything they need from the delegation prompt. Ignored when the agent runs as the main session agent via `--agent` or the `agent` setting. Requires Claude Code v2.1.271 or later |
| `effort` | No | Effort level when this subagent is active. Overrides the session effort level, but not the [`CLAUDE_CODE_EFFORT_LEVEL`](https://code.claude.com/docs/en/env-vars#variables) environment variable. Options: `low`, `medium`, `high`, `xhigh`, `max`; available levels depend on the model. See [Choose an effort level](#choose-an-effort-level) |
| `isolation` | No | Set to `worktree` to run the subagent in a temporary [git worktree](https://code.claude.com/docs/en/worktrees.md), giving it an isolated copy of the repository branched by default from your [default branch](https://code.claude.com/docs/en/worktrees.md#choose-the-base-branch) rather than the parent session's `HEAD`. The worktree is automatically cleaned up if the subagent makes no changes |
| `color` | No | Display color for the subagent in the task list and transcript. Accepts `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, or `cyan` |
| `initialPrompt` | No | Auto-submitted as the first user turn when this agent runs as the main session agent (via `--agent` or the `agent` setting). [Commands](https://code.claude.com/docs/en/commands.md) and [skills](https://code.claude.com/docs/en/skills.md) are processed. Prepended to any user-provided prompt. Ignored for [plugin subagents](#choose-the-subagent-scope) |
| `experimental` | No | Map of experimental options. Set its `cacheTtl` key to `5m` or `1h` to choose the [prompt cache lifetime](https://code.claude.com/docs/en/prompt-caching.md#choose-the-ttl-yourself) for this subagent's requests, at the frontmatter's place in the [cache lifetime precedence](https://code.claude.com/docs/en/prompt-caching.md#choose-the-ttl-yourself). Claude Code ignores any other value, ignores `1h` while your Claude subscription is using usage credits, and reads the field only from subagent files. Requires Claude Code v2.1.248 or later |

Write `cacheTtl` inside the `experimental` map, not at the top level of the frontmatter.

```yaml theme={null}
---
name: repo-auditor
description: Audits a large repository and reports what it finds
experimental:
  cacheTtl: 1h
---
```

#### Subagent files Claude Code skips

Claude Code skips a file in a project, user, or managed `agents` directory, or in one under a directory you add with `--add-dir`, without reporting it in the session, when the frontmatter has any of these problems:

* **No `name`**: Claude Code treats the file as documentation kept beside your agents.
* **An opening `---` that isn't the file's first line**: Claude Code reads the file as having no frontmatter and treats it as documentation.
* **A `name` that starts with `-`, contains `:`, or is longer than 256 characters**: Claude Code skips the file and writes an error to the debug log.
* **A `name` but no `description`**: Claude Code skips the file and writes the reason to the debug log.
* **YAML that doesn't parse**: Claude Code reads no fields from the file, skips it, and writes the parse error to the debug log.

To see the debug log, run Claude Code with `--debug`.

A [plugin subagent](https://code.claude.com/docs/en/plugins/components.md#agents) whose frontmatter has no `name` or doesn't parse still loads, under its filename.

##### Check an `agents` directory before a session

To find files in an `agents` directory whose frontmatter doesn't parse, run `claude plugin validate` against the directory, for example `.claude/agents` or `~/.claude/agents`. Claude Code checks only [the directory you name](https://code.claude.com/docs/en/plugins/cli-reference.md#validate-a-directory), and doesn't flag a file whose frontmatter parses but has no `name`. Requires Claude Code v2.1.233 or later.

### Choose a model

The `model` field controls which model the subagent uses:

* **Model alias**: use one of the available aliases: `sonnet`, `opus`, `haiku`, or `fable`
* **Full model ID**: use a full model ID such as `claude-opus-5-5` or `claude-sonnet-5`. Accepts the same values as the `--model` flag
* **inherit**: use the same model as the main conversation

When Claude invokes a subagent, it can also pass a `model` parameter for that specific invocation. Claude Code resolves the subagent's model in this order:

1. The per-invocation `model` parameter
2. The subagent definition's `model` frontmatter, where `inherit` selects the main conversation's model
3. The [`CLAUDE_CODE_SUBAGENT_MODEL`](https://code.claude.com/docs/en/model-config#environment-variables) environment variable, when you set it to a model alias or model ID
4. The main conversation's model

If an installed [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) sets a model in its [`agent.spawn`](https://code.claude.com/docs/en/plugins/mods/reference#subagents) hook, Claude Code uses that model in place of the per-invocation parameter.

In two cases, a family alias such as `opus` in the per-invocation parameter or the frontmatter resolves to the main conversation's model instead of the [version the alias points to](https://code.claude.com/docs/en/model-config.md#model-aliases):

* **The main conversation's model belongs to that family**: the subagent runs on the main conversation's exact model, including any `[1m]` suffix, so it gets the same [extended context](https://code.claude.com/docs/en/model-config.md#extended-context) window as the main conversation.
* **Claude Code can't tell the main conversation's model family, on [a provider other than the Anthropic API](https://code.claude.com/docs/en/third-party-integrations.md)**: this can happen with an [application inference profile ARN](https://code.claude.com/docs/en/amazon-bedrock.md#iam-configuration) on Amazon Bedrock that Claude Code hasn't resolved to a backing model. This case covers only the `opus` alias, and doesn't apply when you set [`ANTHROPIC_DEFAULT_OPUS_MODEL`](https://code.claude.com/docs/en/model-config#environment-variables), since `opus` then resolves to the model you set.

An alias in `CLAUDE_CODE_SUBAGENT_MODEL` always resolves to the version the alias points to, even when it names the main conversation's family. Setting the variable to `inherit` is the same as leaving it unset.

Setting `CLAUDE_CODE_SUBAGENT_MODEL` by itself doesn't change the model the built-in Explore and Plan subagents run on. To change it, see [Run every subagent on one model](#run-every-subagent-on-one-model).

Before v2.1.251, `CLAUDE_CODE_SUBAGENT_MODEL` came first in this order and overrode both the per-invocation parameter and the frontmatter, including `model: inherit`.

Claude Code checks the per-invocation parameter, frontmatter, and environment variable values against your organization's [`availableModels`](https://code.claude.com/docs/en/model-config#restrict-model-selection) allowlist. For a blocked value, it substitutes another model:

* When the blocked value is a family alias such as `opus`, Claude Code runs the subagent on the newest version of that family the allowlist permits, following the same [substitution rules and provider scope](https://code.claude.com/docs/en/model-config.md#restrict-model-selection) as `/model`. Before v2.1.222, Claude Code ran the subagent on the inherited model for a blocked family alias as well.
* For any other blocked value, on providers where that substitution doesn't operate, or when the allowlist permits no version of the family, Claude Code runs the subagent on the inherited model instead. If you set `CLAUDE_CODE_SUBAGENT_MODEL`, Claude Code tries that model first, under these same rules.

In interactive sessions, Claude Code shows a warning naming the requested model and the model the subagent runs on, for either substitution.

To check which model a subagent is running on, run [`/tasks`](https://code.claude.com/docs/en/commands). Claude Code names the model on the subagent's row, and adds the [effort level](https://code.claude.com/docs/en/model-config.md#adjust-effort-level) set for that subagent, if any. Requires Claude Code v2.1.242 or later.

A per-invocation `model` parameter also applies when the subagent is [resumed or sent a follow-up message](#resume-subagents), so the subagent stays on that model.

As of v2.1.198, subagents also inherit the main conversation's [extended thinking](https://code.claude.com/docs/en/model-config.md#extended-thinking) configuration: if thinking is on in your session, it's on for the subagent, and if it's off, it stays off. There is no per-subagent thinking setting. Before v2.1.198, subagents ran with extended thinking disabled regardless of the main conversation's setting.

#### Run every subagent on one model

`CLAUDE_CODE_SUBAGENT_MODEL` is a default, so a subagent's definition or a model Claude passes still takes precedence over it. To apply one model to every subagent, [teammate](https://code.claude.com/docs/en/agent-teams.md#specify-teammates-and-models), and [workflow agent](https://code.claude.com/docs/en/workflows.md), also set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` to `1`. Requires Claude Code v2.1.257 or later.

* If you set both variables, subagents run on the model in `CLAUDE_CODE_SUBAGENT_MODEL`.
* If you set only `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, subagents run on the main conversation's model, except that the built-in Explore subagent runs on the [model listed for it under Built-in subagents](#built-in-subagents).

For example, to run every subagent on Haiku, set both variables in the `env` block of a [settings file](https://code.claude.com/docs/en/settings.md):

```json theme={null}
{
  "env": {
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"
  }
}
```

To check that the setting took effect, run [`/tasks`](https://code.claude.com/docs/en/commands) while a subagent is running. The subagent's row shows the model it runs on.

While `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is [on](https://code.claude.com/docs/en/env-vars.md), Claude Code ignores the `model` field in subagent definitions, and Claude can't pass a model when it starts a subagent. These subagents still run on the main conversation's model:

* A [fork](#fork-the-current-conversation)
* A [skill that runs in a subagent](https://code.claude.com/docs/en/skills.md#run-skills-in-a-subagent) with `model: inherit`

### Choose an effort level

To run a subagent at its own [effort level](https://code.claude.com/docs/en/model-config.md#adjust-effort-level), set the [`effort`](#supported-frontmatter-fields) field in its definition.

When you ask Claude to run a non-fork subagent at a specific effort level, it can also pass an `effort` parameter for that invocation. The parameter overrides the `effort` field and stays in effect when the subagent is [resumed](#resume-subagents). The [`CLAUDE_CODE_EFFORT_LEVEL`](https://code.claude.com/docs/en/env-vars#variables) environment variable takes precedence over both. The per-invocation parameter requires Claude Code v2.1.292 or later.

### Control subagent capabilities

You can control what subagents can do through tool access, permission modes, and conditional rules.

#### Available tools

Subagents inherit the [built-in tools](https://code.claude.com/docs/en/tools-reference.md) and MCP tools available in the main conversation, narrowed by two filters: the first removes a short list of tools from every subagent, and the second reduces the built-in tool set for subagents that run in the [background](#run-subagents-in-foreground-or-background), which is the default. On macOS, Linux, and WSL, a subagent can also receive the Glob and Grep tools when the main conversation doesn't have them, as described under [Glob tool behavior](https://code.claude.com/docs/en/tools-reference.md#glob-tool-behavior). [Forks](#fork-the-current-conversation) skip both filters and receive the main conversation's exact tool pool. The first filter removes these tools, even when listed in the `tools` field:

* `Agent`, when the subagent is at the [depth limit](#let-subagents-spawn-their-own-subagents); in a [fork](#fork-the-current-conversation) the tool stays listed but returns an error instead of spawning
* `AskUserQuestion`
* `EndConversation`, which can end only the main conversation; see [EndConversation tool behavior](https://code.claude.com/docs/en/tools-reference.md#endconversation-tool-behavior)
* `EnterPlanMode`
* `ExitPlanMode`, unless the subagent's [`permissionMode`](#permission-modes) is `plan`
* `ScheduleWakeup`
* `WaitForMcpServers`
* `Workflow`

The second filter applies to subagents running in the background. Apart from `Agent` and `ExitPlanMode`, which follow the first filter's conditions wherever the subagent runs, a background subagent keeps every MCP tool but only these built-in tools: `Read`, `Grep`, `Glob`, `LSP`, `Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Skill`, `ToolSearch`, `EnterWorktree`, `ExitWorktree`, `Monitor`, `TaskStop`, `SendMessage`, and `Artifact`, plus [`SubagentHandback`](https://code.claude.com/docs/en/tools-reference) for a subagent that reports through it. Claude Code removes every other built-in tool from a background subagent, whether inherited or listed in the `tools` field, so the same definition can resolve to different tools in the foreground and the background. The removal reports no error unless it leaves the `tools` list [resolving to nothing](https://code.claude.com/docs/en/errors.md#agent-would-be-spawned-with-zero-tools).

Before v2.1.280, background subagents couldn't use `LSP`.

[`ListAgents`](https://code.claude.com/docs/en/cross-session-messaging) follows these filters like any built-in tool: a foreground subagent inherits it in sessions where cross-session messaging is enabled, and a background subagent doesn't keep it.

Teammates in [agent teams](https://code.claude.com/docs/en/agent-teams.md) additionally keep the task tools and cron tools: `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `CronCreate`, `CronDelete`, and `CronList`. In a [session without the Task tools](https://code.claude.com/docs/en/tools-reference.md#task-tool-availability), Claude Code doesn't provide the task tools to subagents either, even when the subagent runs a different model. An in-process teammate follows your session the same way. To find out whether a split-pane teammate has the task tools, see [Task tool availability](https://code.claude.com/docs/en/tools-reference.md#task-tool-availability).

#### Restrict which tools a subagent can use

To restrict tools, use the `tools` field as an allowlist or the `disallowedTools` field as a denylist. If both are set, `disallowedTools` is applied first, then `tools` is resolved against the remaining pool. A tool listed in both is removed.

This example uses `tools` to allow only Read, Grep, Glob, and Bash. The subagent can't edit files, write files, or use any MCP tools:

```yaml theme={null}
---
name: safe-researcher
description: Research agent with restricted capabilities
tools: Read, Grep, Glob, Bash
---
```

This example uses `disallowedTools` to inherit the subagent's tool pool except Write and Edit. The subagent keeps Bash, MCP tools, and the rest of its pool:

```yaml theme={null}
---
name: no-writes
description: Inherits the available tools except file writes
disallowedTools: Write, Edit
---
```

When nothing in the `tools` list resolves to a tool, for example because every entry is misspelled or names a tool that isn't available to subagents, Claude Code usually refuses to launch the subagent and the Agent tool returns an error naming the unresolved entries; see [Agent would be spawned with zero tools](https://code.claude.com/docs/en/errors.md#agent-would-be-spawned-with-zero-tools) for the message and how to fix each entry.

The `tools` and `disallowedTools` fields also take entries for a whole MCP server:

| Goal | Field | Example entry |
| :- | :- | :- |
| Give the subagent every tool from one server | `tools` | `mcp__github__*` |
| Withhold one server's tools | `disallowedTools` | `mcp__github` or `mcp__github__*` |
| Withhold every MCP tool from any server | `disallowedTools` | `mcp__*` |

This example removes every tool from the `github` MCP server while keeping tools from other servers and the built-in tools in the subagent's pool:

```yaml theme={null}
---
name: local-only
description: Inherits every tool except those from the github MCP server
disallowedTools: mcp__github
---
```

A `disallowedTools` entry with a specifier, such as `Bash(git push *)`, still removes the whole tool from the subagent, not only the matching commands. To keep Bash and block specific commands, add a [Bash deny rule](https://code.claude.com/docs/en/permissions.md#bash) such as `Bash(git push *)` to `permissions.deny` in your settings. The rule applies to the main conversation and to subagents.

##### MCP server names that contain a double underscore

If a subagent gets none of the tools from an MCP server whose name contains `__`, such as `reports__v2`, check the subagent's `mcp__` entries:

* **In `tools`**: write `mcp__` followed by the [server's whole name](https://code.claude.com/docs/en/permissions.md#mcp) and `__*`, as in `mcp__reports__v2__*`. Without the trailing `__*`, `mcp__reports__v2` matches none of that server's tools.
* **In `disallowedTools`**: look for `mcp__reports` or `mcp__reports__*`, the entries that withhold a server named `reports`. With either entry, the subagent loses every `reports__v2` tool as well, because those tool names also begin with `mcp__reports__`. To withhold only the `reports` server's tools, list them one by one instead, such as `mcp__reports__run_query`.

#### Restrict which subagents can be spawned

When an agent runs as the main thread with `claude --agent`, it can spawn subagents using the Agent tool. To restrict which subagent types it can spawn, use `Agent(agent_type)` syntax in the `tools` field.

> [!NOTE]
>
> In version 2.1.63, the Task tool was renamed to Agent. Existing `Task(...)` references in settings and agent definitions still work as aliases.

```yaml theme={null}
---
name: coordinator
description: Coordinates work across specialized agents
tools: Agent(worker, researcher), Read, Bash
---
```

This is an allowlist: only the `worker` and `researcher` subagents can be spawned. If the agent tries to spawn any other type, the request fails and the agent sees only the allowed types in its prompt. To block specific agents while allowing all others, use [`permissions.deny`](#disable-specific-subagents) instead.

To allow spawning any subagent without restrictions, use `Agent` without parentheses:

```yaml theme={null}
tools: Agent, Read, Bash
```

If you omit `Agent` from the `tools` list entirely, the agent can't spawn any subagents with the Agent tool.

The `Agent(agent_type)` allowlist syntax applies only to an agent running as the main thread with `claude --agent`. In a subagent definition, listing `Agent` in `tools` lets that subagent spawn subagents of its own while the [depth limit](#let-subagents-spawn-their-own-subagents) allows it, but any type list inside the parentheses is ignored.

#### Scope MCP servers to a subagent

Use the `mcpServers` field to give a subagent access to [MCP](https://code.claude.com/docs/en/mcp.md) servers that aren't available in the main conversation. Inline servers defined here are connected when the subagent starts, subject to the [trust rule for the agent file's folder](#inline-server-trust), and disconnected when it finishes. String references share the parent session's connection.

> [!NOTE]
>
> The `mcpServers` field applies in both contexts where an agent file can run:
>
> * As a subagent, spawned through the Agent tool or an @-mention
> * As the main session, launched with [`--agent`](#invoke-subagents-explicitly) or the `agent` setting
>
> When the agent is the main session, inline server definitions connect at startup alongside servers from [`.mcp.json`](https://code.claude.com/docs/en/mcp) and settings files, under the same [trust rule for the agent file's folder](#inline-server-trust). In `/mcp`, a remote (HTTP or SSE) server you've used before can show the [`cached` status](https://code.claude.com/docs/en/mcp#managing-your-servers) instead; Claude Code connects it when Claude first calls one of its tools.

Each entry in the list is either an inline server definition or a string referencing an MCP server already configured in your session:

```yaml theme={null}
---
name: browser-tester
description: Tests features in a real browser using Playwright
mcpServers:
  # Inline definition: scoped to this subagent only
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
  # Reference by name: reuses an already-configured server
  - github
---

Use the Playwright tools to navigate, screenshot, and interact with pages.
```

Inline definitions use the same schema as `.mcp.json` server entries, keyed by the server name, and support the `stdio`, `http`, `sse`, and `ws` types.

To keep an MCP server out of the main conversation entirely and avoid its tool descriptions consuming context there, define it inline here rather than in `.mcp.json`. The subagent gets the tools; the parent conversation doesn't.

The MCP restrictions that apply to the main session also cover servers declared in subagent frontmatter:

* [`--strict-mcp-config`](https://code.claude.com/docs/en/cli-reference) and [`--bare`](https://code.claude.com/docs/en/cli-reference)
* [Enterprise managed MCP configuration](https://code.claude.com/docs/en/managed-mcp.md)
* [`allowedMcpServers` and `deniedMcpServers` policies](https://code.claude.com/docs/en/managed-mcp#policy-based-control-with-allowlists-and-denylists)

When one of these blocks a server, Claude Code skips it and shows a warning naming the blocked servers.

Managed-settings restrictions apply to every subagent regardless of how it is defined. `--strict-mcp-config` doesn't filter servers you pass inline via `--agents` or the SDK `agents` option, since those are explicit caller input.

#### Trust required for inline MCP servers

Claude Code loads an [inline MCP server](#scope-mcp-servers-to-a-subagent) from an agent file in your project's `.claude/agents/` directory, or in an `--add-dir` directory's `.claude/agents/`, only after you [trust the folder the agent file came from](https://code.claude.com/docs/en/permissions.md#what-runs-before-you-trust-a-folder). Before v2.1.238, Claude Code loaded these servers without checking trust.

* **Trust that doesn't count**: a parent folder's trust, and the automatic trust a `-p` or SDK session gets for [hooks in settings files](https://code.claude.com/docs/en/permissions.md#what-runs-before-you-trust-a-folder)
* **Until then**: Claude Code skips every inline server in that agent file and writes the exact `projects["<path>"].hasTrustDialogAccepted` key for `~/.claude.json` to the debug log
* **`--add-dir` directories**: a directory outside your trusted workspace's repository needs its own trust entry, since its `.claude/agents/` files don't inherit your workspace's trust

Claude Code loads two kinds of server without checking trust for the folder the agent file came from:

* A name that references a server you already configured
* An inline server in an agent file from `~/.claude/agents/`, in one you pass with `--agents` or the SDK `agents` option, or in one that managed settings supplies

#### Permission modes

Set `permissionMode` to choose the permission mode a subagent runs in. Use the modes' config values, so Manual mode is `default`. If you leave it unset, the subagent inherits the main conversation's [permission mode](https://code.claude.com/docs/en/permission-modes.md).

The main conversation's permission mode decides whether Claude Code uses the value you set:

* When the main conversation is in `bypassPermissions`, `acceptEdits`, or [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode), the subagent runs in that same mode and Claude Code ignores the `permissionMode` you set. Under auto mode, the classifier evaluates the subagent's tool calls with the main conversation's block and allow rules. When the subagent finishes, the classifier also reviews its work and its final report before the report is delivered, as [How auto mode handles subagents](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) describes.
* When the main conversation is in `plan` mode, the subagent stays in plan mode whichever `permissionMode` you set, unless it runs as an [agent team teammate](#subagent-names) under the [agent teams rules](https://code.claude.com/docs/en/agent-teams.md#have-teammates-plan-before-implementing). If you set `dontAsk`, the subagent also doesn't prompt you: an action that plan mode would ask you to approve is denied instead.
* When the main conversation is in `default` or `dontAsk` mode, the subagent runs in the permission mode you set. It keeps the main conversation's permission mode instead in these cases:
  * You set `bypassPermissions`. The `bypassPermissions` exception requires Claude Code v2.1.267 or later.
  * You set `auto` and [auto mode isn't available](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) to the subagent, such as when a settings file sets [`disableAutoMode`](https://code.claude.com/docs/en/settings-reference#disableautomode) or the subagent's model doesn't support auto mode.

`permissionMode` accepts these values, and `manual` as an alias for `default`:

| Mode | Behavior |
| :- | :- |
| `default` | Manual mode: prompts for permission |
| `acceptEdits` | Auto-accept file edits and common filesystem commands for paths in the working directory or `additionalDirectories` |
| `auto` | [Auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode): a background classifier reviews commands and protected-directory writes |
| `dontAsk` | Auto-denies calls that would prompt, though a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) you installed can still approve [some of those calls](https://code.claude.com/docs/en/permissions.md#precedence-among-rules-hooks-and-mods). Explicitly allowed tools still work. `AskUserQuestion`, MCP tools marked [`requiresUserInteraction`](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool), [reads from network paths](https://code.claude.com/docs/en/permissions.md#network-paths), and connector tools [your organization set to `ask`](https://code.claude.com/docs/en/mcp#organization-controls-on-connector-tools) in sessions where that setting reaches Claude Code are denied even if you've allowed them |
| `bypassPermissions` | [Skip permission prompts](https://code.claude.com/docs/en/permission-modes.md#skip-all-checks-with-bypasspermissions-mode). A subagent runs in this mode only when the main conversation does |
| `plan` | Plan mode (read-only exploration) |

#### Preload skills into subagents

Use the `skills` field to inject skill content into a subagent's context at startup. This gives the subagent domain knowledge without requiring it to discover and load skills during execution.

```yaml theme={null}
---
name: api-developer
description: Implement API endpoints following team conventions
skills:
  - api-conventions
  - error-handling-patterns
---

Implement API endpoints. Follow the conventions and patterns from the preloaded skills.
```

The full content of each listed skill is injected into the subagent's context at startup, up to the first 32 distinct names in the list. This field controls which skills are preloaded, not which skills the subagent can access: without it, the subagent can still discover and invoke project, user, and plugin skills through the Skill tool during execution. To prevent a subagent from invoking skills entirely, omit `Skill` from the [`tools`](#available-tools) list or add it to `disallowedTools`.

You can't preload skills that set [`disable-model-invocation: true`](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill), since preloading draws from the same set of skills Claude can invoke. This includes the bundled `/verify` skill, which Claude can't run on its own.

If a listed skill is missing or disabled, for example by your organization's policy, Claude Code skips it and logs a warning to the debug log.

> [!NOTE]
>
> This is the inverse of [running a skill in a subagent](https://code.claude.com/docs/en/skills.md#run-skills-in-a-subagent). With `skills` in a subagent, the subagent controls the system prompt and loads skill content. With `context: fork` in a skill, the skill content is injected into the agent you specify. In both cases the subagent starts without your conversation history.

#### Enable persistent memory

The `memory` field gives the subagent a persistent directory that survives across conversations. The subagent uses this directory to build up knowledge over time, such as codebase patterns, debugging insights, and architectural decisions.

```yaml theme={null}
---
name: code-reviewer
description: Reviews code for quality and best practices
memory: user
---

You are a code reviewer. As you review code, update your agent memory with
patterns, conventions, and recurring issues you discover.
```

Choose a scope based on how broadly the memory should apply:

| Scope | Location | Use when |
| :- | :- | :- |
| `user` | `~/.claude/agent-memory/<name-of-agent>/` | the subagent should remember learnings across all projects |
| `project` | `.claude/agent-memory/<name-of-agent>/` | the subagent's knowledge is project-specific and shareable via version control |
| `local` | `.claude/agent-memory-local/<name-of-agent>/` | the subagent's knowledge is project-specific but shouldn't be checked into version control |

Subagent memory is part of [auto memory](https://code.claude.com/docs/en/memory.md#auto-memory): if you turn auto memory off, with the `autoMemoryEnabled` setting or `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, the `memory` field has no effect and the subagent launches without the memory instructions or the memory tool access described below.

When memory is enabled:

* The subagent's system prompt includes instructions for reading and writing to the memory directory.
* The subagent's system prompt also includes the first 200 lines or 25KB of `MEMORY.md` in the memory directory, whichever comes first, with instructions to curate `MEMORY.md` if it exceeds that limit.
* Read, Write, and Edit tools are automatically enabled so the subagent can manage its memory files.

##### Persistent memory tips

* `project` is the recommended default scope. It makes subagent knowledge shareable via version control.
* Ask the subagent to consult its memory before starting work: "Review this PR, and check your memory for patterns you've seen before."
* Ask the subagent to update its memory after completing a task: "Now that you're done, save what you learned to your memory." Over time, this builds a knowledge base that makes the subagent more effective.
* Include memory instructions directly in the subagent's markdown file so it proactively maintains its own knowledge base:

  ```markdown theme={null}
  Update your agent memory as you discover codepaths, patterns, library
  locations, and key architectural decisions. This builds up institutional
  knowledge across conversations. Write concise notes about what you found
  and where.
  ```

#### Conditional rules with hooks

For more dynamic control over tool usage, use `PreToolUse` hooks to validate operations before they execute. This is useful when you need to allow some operations of a tool while blocking others.

This example creates a subagent that only allows read-only database queries. The `PreToolUse` hook runs the script specified in `command` before each Bash command executes:

```yaml theme={null}
---
name: db-reader
description: Execute read-only database queries
tools: Bash
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
---
```

Claude Code [passes hook input as JSON](https://code.claude.com/docs/en/hooks.md#pretooluse-input) via stdin to hook commands. The validation script reads this JSON, extracts the Bash command, and [exits with code 2](https://code.claude.com/docs/en/hooks.md#exit-code-2-behavior-per-event) to block write operations:

```bash theme={null}
#!/bin/bash
# ./scripts/validate-readonly-query.sh

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Block SQL write operations (case-insensitive)
if echo "$COMMAND" | grep -iE '\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b' > /dev/null; then
  echo "Blocked: Only SELECT queries are allowed" >&2
  exit 2
fi

exit 0
```

On macOS and Linux, make the script executable, or the hook fails instead of blocking anything:

```bash theme={null}
chmod +x ./scripts/validate-readonly-query.sh
```

To test the rule, ask the subagent to run an `UPDATE` statement: the script exits with code 2, Claude Code blocks the command, and the subagent sees the `Blocked: Only SELECT queries are allowed` message.

See [Hook input](https://code.claude.com/docs/en/hooks.md#pretooluse-input) for the complete input schema and [exit codes](https://code.claude.com/docs/en/hooks.md#exit-code-output) for how exit codes affect behavior. On Windows, write hook scripts in PowerShell and add `shell: powershell` to the hook entry as shown in [running hooks in PowerShell](https://code.claude.com/docs/en/hooks.md#windows-powershell-tool).

#### Disable specific subagents

You can prevent Claude from using specific subagents by adding them to the `deny` array in your [settings](https://code.claude.com/docs/en/settings-reference.md#permission-settings). Use the format `Agent(subagent-name)` where `subagent-name` matches the subagent's name field.

```json theme={null}
{
  "permissions": {
    "deny": ["Agent(Explore)", "Agent(my-custom-agent)"]
  }
}
```

This works for both built-in and custom subagents. You can also use the `--disallowedTools` CLI flag:

```bash theme={null}
claude --disallowedTools "Agent(Explore)"
```

See [Permissions documentation](https://code.claude.com/docs/en/permissions.md#tool-specific-permission-rules) for more details on permission rules.

### Define hooks for subagents

Subagents can define [hooks](https://code.claude.com/docs/en/hooks.md) that run during the subagent's lifecycle. There are two ways to configure hooks:

* **In the subagent's frontmatter**: define hooks that run only while that subagent is active
* **In `settings.json`**: define session-wide hooks that also fire inside subagents. Tool events such as `PreToolUse` and `PostToolUse` fire for the subagent's tool calls the same way they do in the main conversation, and `SubagentStart` and `SubagentStop` fire when a subagent starts or finishes

Hooks from [settings files, managed policy settings, and plugins](https://code.claude.com/docs/en/hooks.md#hook-locations) all apply inside subagents, so a `PreToolUse` hook in `settings.json` also runs before every tool a subagent uses.

#### Hooks in subagent frontmatter

Define hooks directly in the subagent's markdown file. These hooks only run while that specific subagent is active and are cleaned up when it finishes.

> [!NOTE]
>
> Frontmatter hooks fire when the agent is spawned as a subagent through the Agent tool or an @-mention, and when the agent runs as the main session via [`--agent`](#invoke-subagents-explicitly) or the `agent` setting. In the main-session case they run alongside any hooks defined in [`settings.json`](https://code.claude.com/docs/en/hooks).

To let a project-level subagent's frontmatter hooks run, accept the [workspace trust dialog](https://code.claude.com/docs/en/permissions.md#project-allow-rules-and-workspace-trust) for the folder that contains the agent file. Hooks from user-level subagents in `~/.claude/agents/` and from definitions you pass with `--agents` run without this step. If you added a folder with `--add-dir` from outside your trusted workspace's repository, trust that folder separately: its `.claude/agents/` hooks don't inherit the workspace's grant.

Until you trust the folder, the subagent still runs, but Claude Code skips its frontmatter hooks and logs an error to the debug log explaining how to trust the folder. This is a stricter rule than the one for hooks in settings files: trusting a parent folder isn't enough, and a `-p` session doesn't count as trusted. [What runs before you trust a folder](https://code.claude.com/docs/en/permissions.md#what-runs-before-you-trust-a-folder) compares the two.

All [hook events](https://code.claude.com/docs/en/hooks.md#hook-events) are supported. The most common events for subagents are:

| Event | Matcher input | When it fires |
| :- | :- | :- |
| `PreToolUse` | Tool name | Before the subagent uses a tool |
| `PostToolUse` | Tool name | After the subagent uses a tool |
| `Stop` | (none) | When the subagent finishes (converted to `SubagentStop` at runtime) |

This example validates Bash commands with the `PreToolUse` hook and runs a linter after file edits with `PostToolUse`:

```yaml theme={null}
---
name: code-reviewer
description: Review code changes with automatic linting
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-command.sh"
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "./scripts/run-linter.sh"
---
```

When the agent is invoked as a subagent, `Stop` hooks in frontmatter are automatically converted to `SubagentStop` events.

#### Project-level hooks for subagent events

Configure hooks in `settings.json` that respond to subagent lifecycle events in the main session.

| Event | Matcher input | When it fires |
| :- | :- | :- |
| `SubagentStart` | Agent type name | When a subagent begins execution |
| `SubagentStop` | Agent type name | When a subagent completes |

Both events support matchers to target specific agent types by name. The matcher value is the agent's frontmatter `name` for project-level and user-level subagents, or the plugin-scoped identifier such as `my-plugin:db-agent` for [plugin subagents](https://code.claude.com/docs/en/plugins/components.md#agents). A scoped name contains a colon, so it is evaluated as an [unanchored regular expression](https://code.claude.com/docs/en/hooks.md#matcher-patterns); anchor it with `^` and `$`, as in `^my-plugin:db-agent$`, to match only that agent.

This example runs a setup script only when the `db-agent` subagent starts, and a cleanup script when any subagent stops:

```json theme={null}
{
  "hooks": {
    "SubagentStart": [
      {
        "matcher": "db-agent",
        "hooks": [
          { "type": "command", "command": "./scripts/setup-db-connection.sh" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          { "type": "command", "command": "./scripts/cleanup-db-connection.sh" }
        ]
      }
    ]
  }
}
```

See [Hooks](https://code.claude.com/docs/en/hooks.md) for the complete hook configuration format.

## Work with subagents

### Understand automatic delegation

Claude automatically delegates tasks based on the task description in your request, the `description` field in subagent configurations, and current context. To encourage proactive delegation, include phrases like "use proactively" in your subagent's description field.

Keep descriptions brief: Claude Code shows a startup warning when your subagents' combined descriptions pass [the 15,000-token limit](https://code.claude.com/docs/en/errors.md#agent-descriptions-are-over-the-15000-token-limit), and still loads every subagent.

If the subagent ships in a [plugin](https://code.claude.com/docs/en/plugins/overview.md), you can measure how reliably Claude delegates to it across realistic prompts instead of checking one at a time: [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals) runs each prompt with and without the plugin and scores the results.

### Invoke subagents explicitly

When automatic delegation isn't enough, you can request a subagent yourself. Three patterns escalate from a one-off suggestion to a session-wide default:

* **Natural language**: name the subagent in your prompt; Claude decides whether to delegate
* **@-mention**: guarantees the subagent runs for one task
* **Session-wide**: the whole session runs as that subagent via the `--agent` flag or the `agent` setting

For natural language, there's no special syntax. Name the subagent and Claude typically delegates:

```text wrap theme={null}
Use the test-runner subagent to fix failing tests
Have the code-reviewer subagent look at my recent changes
```

**@-mention the subagent.** Type `@` and pick the subagent from the typeahead, the same way you @-mention files. This ensures that specific subagent runs rather than leaving the choice to Claude:

```text wrap theme={null}
@"code-reviewer (agent)" look at the auth changes
```

Your full message still goes to Claude, which writes the subagent's task prompt based on what you asked. The @-mention controls which subagent Claude invokes, not what prompt it receives.

Subagents provided by an enabled [plugin](https://code.claude.com/docs/en/plugins/overview.md) appear in the typeahead under their scoped name, such as `my-plugin:code-reviewer` or `my-plugin:review:security` when the plugin [organizes agents into subfolders](#choose-the-subagent-scope). Named background subagents currently running in the session also appear in the typeahead, showing their status next to the name.

You can also type the mention manually without using the picker: `@agent-<name>` for local subagents, or `@agent-` followed by the scoped name for plugin subagents, for example `@agent-my-plugin:code-reviewer`. While you type this form the typeahead shows file matches rather than agents. The agent mention still resolves when you submit.

**Run the whole session as a subagent.** Pass [`--agent <name>`](https://code.claude.com/docs/en/cli-reference) to start a session where the main thread itself takes on that subagent's tool restrictions and model:

```bash theme={null}
claude --agent code-reviewer
```

Unless the agent's [prompt is empty](#choose-the-subagent-scope), a custom subagent's system prompt replaces the default Claude Code system prompt entirely, the same way [`--system-prompt`](https://code.claude.com/docs/en/cli-reference) does. `CLAUDE.md` files and project memory still load through the normal message flow, even when the agent's definition sets [`omitClaudeMd`](#supported-frontmatter-fields). If you run the session with `-p` as a custom agent that has its own prompt, it also starts without the [git status snapshot](https://code.claude.com/docs/en/settings-reference.md#includegitinstructions).

The agent name appears as `@<name>` in the startup header so you can confirm it's active.

This works with built-in and custom subagents, and the choice persists when you resume the session: Claude Code restores the agent's tool restrictions and model along with the conversation. If the agent no longer exists when you resume, the session continues with the default tools and shows a [warning naming the agent](https://code.claude.com/docs/en/errors.md#session-agent-no-longer-available). For the system prompt in either case, see [System prompt flags in resumed conversations](https://code.claude.com/docs/en/cli-reference.md#system-prompt-flags-in-resumed-conversations).

For a plugin-provided subagent, you can pass only the agent name and Claude Code finds it:

```bash theme={null}
claude --agent security-reviewer
```

If multiple plugins provide agents with the same name, pass the scoped name to disambiguate:

```bash theme={null}
claude --agent my-plugin:security-reviewer
```

If the plugin places the agent in a subfolder of its `agents/` directory, include the subfolder in the scoped name, for example `claude --agent my-plugin:review:security`.

To make it the default for every session in a project, set `agent` in `.claude/settings.json`:

```json theme={null}
{
  "agent": "code-reviewer"
}
```

The CLI flag overrides the setting if both are present.

### Run subagents in foreground or background

Subagents can run in the foreground or the background:

* **Foreground subagents** block the main conversation until complete. Permission prompts are passed through to you as they come up.
* **Background subagents** run concurrently while you continue working. When a background subagent reaches a tool call that needs permission, Claude Code surfaces the prompt in your main session and names the subagent that is asking. Approve to let the subagent continue, or press Esc to deny that one tool call without stopping the subagent.

#### Which subagents run in the background

With nothing configured, a subagent that Claude spawns from your main conversation starts in the background.

* **`claude -p` and the Agent SDK**: Claude can wait, on its own judgment or when you ask.
* **Interactive terminal session, VS Code, and desktop app sessions on your machine**: to let Claude wait for a subagent, [turn off fork mode](#let-claude-wait-for-a-subagent), which is [on by default](#turn-fork-mode-on-or-off).

For a skill with `context: fork`, Claude Code follows the rules in [Run skills in a subagent](https://code.claude.com/docs/en/skills.md#run-skills-in-a-subagent) instead, whether or not fork mode is on.

#### Let Claude wait for a subagent

1. Turn [fork mode](#turn-fork-mode-on-or-off) off by setting `CLAUDE_CODE_FORK_SUBAGENT` to `0`, for example in [`settings.json`](https://code.claude.com/docs/en/settings):

   ```json theme={null}
   {
     "env": {
       "CLAUDE_CODE_FORK_SUBAGENT": "0"
     }
   }
   ```

2. Run `claude` again from your shell, or open a new VS Code conversation.

3. Ask Claude to wait when you need a result first, for example "run the reviewer subagent and wait for its report".

To keep working while Claude waits, press **Ctrl+B** in the terminal or click [**Run in background**](https://code.claude.com/docs/en/vs-code.md#move-a-running-command-or-subagent-to-the-background) in VS Code.

If you set the [`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`](https://code.claude.com/docs/en/env-vars) environment variable to `1` instead of turning fork mode off, Claude waits for every subagent. Background commands are off too, and **Ctrl+B** doesn't move anything to the background.

#### Tools, permissions, and results of background subagents

Background subagents run with a [smaller built-in tool set](#available-tools) than foreground subagents, except for conversation forks and [resumed](#resume-subagents) foreground subagents.

Background subagents surface every permission prompt in your main session. When you answer one of those prompts with a choice that lasts beyond that one tool call, such as a grant that lasts for the rest of the session, Claude Code applies your answer to the whole session, including your main conversation.

A background subagent can leave a background [Bash or PowerShell command](https://code.claude.com/docs/en/tools-reference.md#background-commands) [running past the end of its turn](https://code.claude.com/docs/en/interactive-mode.md#how-backgrounding-works). When that command ends, Claude Code sends the subagent a notification.

A background subagent's results reach Claude as a completion notification in a later turn. Claude waits for that notification before reporting the subagent's results, and if you ask about progress first, it reports that the subagent is still running.

#### Finished subagents in the panel and task list

Claude Code clears a background subagent's row from the subagent panel below the prompt input in one of two ways, depending on how the subagent ended:

* When a subagent finishes successfully, Claude Code removes its row immediately and, except in [screen reader mode](https://code.claude.com/docs/en/accessibility.md), shows `/tasks to see subagents` in the footer for 30 seconds. During those 30 seconds, run [`/tasks`](https://code.claude.com/docs/en/commands) and press `Enter` on the subagent to open its transcript. Before v2.1.232, Claude Code kept the row for 30 seconds after the subagent finished, the same as a failed one, and showed no footer hint.
* When a subagent fails or you stop it, Claude Code keeps its row for 30 seconds. To clear the row sooner, select it and press `x`.

A background subagent that completes stays listed in [`/tasks`](https://code.claude.com/docs/en/commands), marked done and sorted below running work, for the same 30 seconds as the footer hint. Its detail view stays open when the subagent finishes. Subagents that fail or that you stop leave the list. Before v2.1.208, a completed subagent left the list the moment it finished and its detail view closed.

### Subagent names

If you start a session with [agent teams](https://code.claude.com/docs/en/agent-teams.md#enable-agent-teams) enabled, Claude can give a subagent a name by passing a `name` parameter on the Agent tool call. It may do so on its own, without asking you first. The name makes the subagent addressable: Claude can [message or resume it by name](#resume-subagents) after it finishes.

In an interactive session with [agent teams](https://code.claude.com/docs/en/agent-teams.md) enabled, a subagent that Claude spawns from the main conversation with a `name` launches as a teammate instead, unless the call is a [fork](#fork-the-current-conversation) or passes `isolation` on the call itself. An `isolation` value in the subagent's frontmatter doesn't prevent it, and the teammate then runs in the main session's working directory. See [How Claude starts agent teams](https://code.claude.com/docs/en/agent-teams.md#how-claude-starts-agent-teams).

### API errors in subagents

When something [cuts off a subagent's response mid-stream](https://code.claude.com/docs/en/errors.md#the-response-above-may-be-incomplete), and the partial response contains text but no tool calls, Claude Code prompts the subagent to continue rather than ending the run. This happens in interactive sessions too. The run ends on the error only once those continuations are used up.

A subagent whose run ends on an API error, such as a usage limit or a repeated server error, reports that failure back to Claude. What Claude receives depends on where the subagent ran:

* **Foreground**: if a rate limit, overload, or server error cuts off a subagent that already produced text output, the Agent tool returns that partial output with a note that the subagent was cut off and didn't finish its task. A subagent that produced nothing, or whose only output was tool calls, fails with [`Agent terminated early due to an API error`](https://code.claude.com/docs/en/errors#agent-terminated-early-due-to-an-api-error), followed by the error detail.
* **Background**: the subagent is marked failed, and the message Claude receives when it ends names the API error and includes the subagent's last output, so partial work isn't lost.

If a subagent's report opens with the following line, the subagent finished on a fallback model:

```text theme={null}
⚠ This agent switched to <model> because its earlier model could not be used.
```

When you configure a [fallback model chain](https://code.claude.com/docs/en/model-config.md#fallback-model-chains) and a subagent encounters a failure the chain covers, such as its model being unavailable, Claude Code switches the subagent to the first model in the chain that accepts the request. The subagent keeps working instead of ending on the error.

Once the underlying API error clears, ask Claude to retry the task or [resume the subagent](#resume-subagents).

### Subagent output scanning

Claude Code scans each subagent's final report before Claude reads it. A subagent may have read files, web pages, or command output you never reviewed, and text from those sources can carry instructions aimed at the main conversation. The scan never removes or rewords anything; it makes two kinds of change you may notice in a report:

* **Backslash insertion**: the scan inserts a backslash into text that imitates Claude Code's own output, such as a `<system-reminder>` tag or a line starting with `Human:` or `Assistant:`, so the imitation reads as ordinary text instead of being mistaken for part of the conversation.
* **Marker line**: the scan prepends a line starting with `[harness: subagent output matched instruction-shaped pattern(s):` when the report imitates a tag like `<system-reminder>` or mentions permission settings such as `bypassPermissions` or `--dangerously-skip-permissions`. Permission-setting mentions get the marker line, but the text itself stays as written.

The scan doesn't judge whether content is malicious, and it doesn't change what an instruction in a report can do: a tool call the report leads Claude to make still goes through the session's [permission checks](https://code.claude.com/docs/en/permissions.md) and [sandboxing](https://code.claude.com/docs/en/sandboxing.md). It isn't a substitute for [restricting what a subagent can reach](#control-subagent-capabilities).

A report that returns to Claude as the subagent's result also arrives under a header marking it as subagent output. The header states that instructions or approval claims inside the report are the subagent's words and carry no authority from you.

A [background subagent's report](#run-subagents-in-foreground-or-background) arrives inside a completion notification, which is marked as an automated event rather than a message from you.

### Common patterns

#### Isolate high-volume operations

One of the most effective uses for subagents is isolating operations that produce large amounts of output. Running tests, fetching documentation, or processing log files can consume significant context. By delegating these to a subagent, the verbose output stays in the subagent's context while only the relevant summary returns to your main conversation.

```text wrap theme={null}
Use a subagent to run the test suite and report only the failing tests with their error messages
```

#### Run parallel research

For independent investigations, spawn multiple subagents to work simultaneously:

```text wrap theme={null}
Research the authentication, database, and API modules in parallel using separate subagents
```

Each subagent explores its area independently, then Claude synthesizes the findings. This works best when the research paths don't depend on each other.

> [!WARNING]
>
> When subagents complete, their results return to your main conversation. Running many subagents that each return detailed results can consume significant context, and each subagent spends tokens of its own while it runs.

For work that needs to keep running in parallel or won't fit in one context window, run it in [separate sessions](https://code.claude.com/docs/en/agents.md) and let Claude [pass findings between them](https://code.claude.com/docs/en/cross-session-messaging.md).

#### Chain subagents

For multi-step workflows, ask Claude to use subagents in sequence. Each subagent completes its task and returns results to Claude, which then passes relevant context to the next subagent.

```text wrap theme={null}
Use the code-reviewer subagent to find performance issues, then use the optimizer subagent to fix them
```

### Choose between subagents and main conversation

Use the **main conversation** when:

* The task needs frequent back-and-forth or iterative refinement
* Multiple phases share significant context, such as planning, implementation, and testing
* You're making a quick, targeted change
* Latency matters. A subagent that isn't a [fork](#fork-the-current-conversation) starts fresh and may need time to gather context

Use **subagents** when:

* The task produces verbose output you don't need in your main context
* You want to enforce specific tool restrictions or permissions
* The work is self-contained and can return a summary

Consider [Skills](https://code.claude.com/docs/en/skills.md) instead when you want reusable prompts or workflows that run in the main conversation context rather than isolated subagent context.

For a question about something already in your conversation, use [`/btw`](https://code.claude.com/docs/en/interactive-mode#side-questions-with-%2Fbtw) instead of a subagent. It sees your full context but has no tool access, and the answer isn't added to history.

### Let subagents spawn their own subagents

By default, a subagent can spawn subagents of its own, up to three layers below the main conversation. At the depth limit, Claude Code withholds the `Agent` tool from every subagent except a [fork](#fork-the-current-conversation), so a subagent at the limit does its delegated work itself and returns one summary. A fork at the limit keeps `Agent` in its inherited tool list, but the tool returns an error instead of spawning.

Nested subagents suit a delegated task that itself splits into parallel subtasks, such as a reviewer subagent that dispatches a verifier per finding. By default the spawning subagent waits for each nested subagent's report:

* **Interactive terminal session**: only the top-level subagent's summary returns to you, because a subagent that launches background subagents waits for their results before it finishes.
* **`claude -p` and the Agent SDK**: the spawning subagent waits while [fork mode](#turn-fork-mode-on-or-off) is on. If you turn fork mode off, nested subagents start in the [background](#run-subagents-in-foreground-or-background) instead. The spawning subagent doesn't wait for a background nested subagent, which reports to your main conversation if it outlasts the spawning subagent.

To change the limit, set [`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`](https://code.claude.com/docs/en/env-vars) to the number of subagent layers you want below your main conversation. For example, this entry in [`settings.json`](https://code.claude.com/docs/en/settings) caps nesting at two layers:

```json theme={null}
{
  "env": {
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "2"
  }
}
```

With this value, your subagents can delegate to a second layer of their own, and that second layer can't delegate further. Set `1` to turn nesting off.

A nested subagent is configured the same way as a top-level one and resolves from the same [scopes](#choose-the-subagent-scope). To keep one subagent from spawning while nesting is on, such as a reviewer that should stay read-only, omit `Agent` from its [`tools`](#available-tools) list or add it to `disallowedTools`.

In the terminal, Claude Code shows nested subagents as a tree in the subagent panel below the prompt input and marks each row that still has descendants in the panel with a `(+N)` count of them. Open a row to see that subagent's siblings and direct children with a path back to `main`.

### Concurrent subagent limit

Two limits control subagent use, each with its own variable: this one stops Claude from spawning more subagents while too many are running, and the [depth limit](#let-subagents-spawn-their-own-subagents) caps how deeply subagents nest. There's no limit on the total number of subagents Claude can spawn over a session.

By default, when 20 subagents are running in a session, spawning another with the Agent tool fails with `Concurrent subagent limit reached`, and the error tells Claude not to retry. Spawning succeeds again when the running count drops below the limit. To change the limit, set [`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`](https://code.claude.com/docs/en/env-vars) to any positive whole number. Sessions with [ultracode](https://code.claude.com/docs/en/model-config.md#adjust-effort-level) active are exempt: the limit isn't enforced there. Requires Claude Code v2.1.217 or later.

The limit blocks only subagents Claude spawns with the Agent tool, but other runs occupy the same slots:

* An in-session fork you start with [`/subtask`](#fork-the-current-conversation) takes a slot while it runs and is never blocked by the limit.
* [Resuming a subagent](#resume-subagents) that already finished takes a fresh slot without checking the limit, so resumes can push the running count past it.

Agents that other features run, such as [workflow](https://code.claude.com/docs/en/workflows.md) agents and [agent team](https://code.claude.com/docs/en/agent-teams.md) teammates, follow their own limits instead.

### Manage subagent context

#### What loads at startup

Each subagent starts with a fresh, isolated context window. It doesn't see your conversation history, the skills you've already invoked, or the files Claude has already read. Claude composes a delegation message that summarizes the task, and the subagent works from there. The exception is a [fork](#fork-the-current-conversation), which inherits the parent conversation instead of starting fresh.

A non-fork subagent's initial context contains:

* **System prompt**: the agent's own prompt plus environment details that Claude Code appends, not the Claude Code system prompt. Custom subagents define theirs in the [markdown body](#write-subagent-files) or `prompt` field. Built-in agents have predefined prompts.
* **Task message**: the delegation prompt Claude writes when it hands off the work.
* **CLAUDE.md files**: every level of the [CLAUDE.md hierarchy](https://code.claude.com/docs/en/memory.md#how-claude-md-files-load) the main conversation loads, including `~/.claude/CLAUDE.md`, project rules, `CLAUDE.local.md`, managed policy files, and any [`AGENTS.md` files](https://code.claude.com/docs/en/memory#agents-md) loaded as project instructions. The built-in Explore and Plan agents skip this. A subagent whose definition sets [`omitClaudeMd`](#supported-frontmatter-fields) loads only the managed policy files, or none at all when the definition comes from [managed settings](#choose-the-subagent-scope).
* **Git status**: a snapshot Claude Code reads from your repository when the subagent starts. For a subagent in [its own worktree](https://code.claude.com/docs/en/worktrees.md#isolate-subagents-with-worktrees) of that repository, the snapshot shows the worktree's branch, status, and recent commits. Absent outside a Git repository or whenever the snapshot is turned off; see [`includeGitInstructions`](https://code.claude.com/docs/en/settings-reference#includegitinstructions). Explore and Plan skip it regardless.
* **Preloaded skills**: full content of any skill named in the agent's [`skills` field](#preload-skills-into-subagents). Built-in agents don't preload skills.
* **Sibling roster**: a [system reminder](https://code.claude.com/docs/en/glossary.md#system-reminder) listing `main` and every other named agent in the session, each a valid `to` value for [`SendMessage`](#resume-subagents). The roster appears only when the subagent's tools include `SendMessage` and at least one other agent has a name, whether Claude named it when spawning it or it runs as an [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate. It is a snapshot taken when the subagent starts, so agents named later don't appear.

To launch one of your own subagents without the user, project, and local CLAUDE.md files, set [`omitClaudeMd: true`](#supported-frontmatter-fields) in its frontmatter or `--agents` JSON. For Explore, Plan, and subagents with `omitClaudeMd`, a subdirectory's `CLAUDE.md` and matching [path-scoped rules](https://code.claude.com/docs/en/memory.md#path-specific-rules) still [load](https://code.claude.com/docs/en/memory.md#how-claude-md-files-load) when the subagent works with files there.

The main conversation still has your full CLAUDE.md when it reads these subagents' results, so most rules don't need to reach the subagent itself. If a rule must, such as "ignore the `vendor/` directory," restate it in the prompt you give Claude when delegating.

You can't change which subagents receive git status. Only Explore and Plan skip it.

Some main-conversation state never reaches a non-fork subagent:

* **Output style**: a subagent runs its own system prompt, so your [output style](https://code.claude.com/docs/en/output-styles.md) doesn't shape its responses, except in a [fork](#fork-the-current-conversation).
* **Auto memory**: the main conversation's [auto memory](https://code.claude.com/docs/en/memory.md#auto-memory) isn't loaded. To give a subagent persistent memory of its own, use the [`memory` field](#enable-persistent-memory).
* **Context window size**: a subagent's context window is sized by its own model, not the parent's. Delegating to a model with a smaller window gives that subagent the smaller window.

#### Resume subagents

Each subagent invocation creates a new instance rather than continuing an earlier one. To continue an existing subagent's work instead of starting over, ask Claude to resume it.

Resumed subagents retain their full conversation history, including all previous tool calls, results, and reasoning. If the subagent spawned [background subagents of its own](#let-subagents-spawn-their-own-subagents), that history includes the results they delivered while it ran. Before v2.1.304, a subagent that Claude messaged or resumed right after it finished could forget its most recent work.

* When a subagent completes, Claude receives its agent ID.
* The built-in Explore and Plan agents are one-shot and return no agent ID, so Claude can't resume them. Use `general-purpose` or a custom subagent when you need to continue the work.
* When a subagent stops at its [`maxTurns`](#supported-frontmatter-fields) limit, Claude Code marks the returned output as partial, and Claude can resume the subagent to continue its work.

Claude uses the `SendMessage` tool with the agent's ID or name as the `to` field to resume it. `SendMessage` doesn't require [agent teams](https://code.claude.com/docs/en/agent-teams.md) to be enabled; only structured team-protocol messages such as `shutdown_request` and `plan_approval_response` do. Beyond subagents and teammates, in sessions where cross-session messaging is enabled, Claude can use the same tool to message [your other Claude Code sessions](https://code.claude.com/docs/en/cross-session-messaging.md), on this machine or [beyond it](https://code.claude.com/docs/en/cross-session-messaging.md#message-sessions-on-other-machines).

To resume a subagent, ask Claude to continue the previous work:

```text wrap theme={null}
Use the code-reviewer subagent to review the authentication module
[Agent completes]

Continue that code review and now analyze the authorization logic
[Claude resumes the subagent with full context from previous conversation]
```

When Claude sends a completed subagent a message with the `SendMessage` tool, the subagent resumes in the background without a new `Agent` invocation. The same applies to a subagent that Claude stopped with the `TaskStop` tool, once its stopped run has exited. The resumed run keeps the [tool set from where the subagent first ran](#run-subagents-in-foreground-or-background) and can keep reading the [prompt cache the original run warmed](https://code.claude.com/docs/en/prompt-caching.md#subagents-and-the-cache).

A subagent that has the `SendMessage` tool can send that message too. In an interactive session, the resumed agent then reports back to the subagent that resumed it, not to your main conversation. That subagent waits for the result before finishing its own work. When a subagent messages an agent it reports to, such as its own launcher, Claude Code resumes that agent without redirecting its results.

A subagent you stopped yourself, with `x` in `/tasks` or an SDK `stop_task` request, doesn't auto-resume. If Claude sends it a message, the message is refused and Claude is told the agent was cancelled.

While [that subagent's row is still in the subagent panel](#run-subagents-in-foreground-or-background), type into its transcript to resume it yourself. After that, a message from Claude can auto-resume it again.

Resuming starts a new run of the agent under the same ID, so a subagent that had already failed or completed shows as running again in the task list and in the Agent SDK's task events.

`SendMessage` checks that a name still refers to the same agent it reached earlier in the conversation. If a newer agent has taken the name, such as a re-spawned background agent that reused it, Claude Code refuses the send rather than delivering it to the wrong agent, and the error reports which agent the name now reaches so Claude can retarget. To reach the earlier agent while it's still running, Claude addresses it by the agent ID it received when it spawned that agent. The check is scoped to the current conversation and resets on `/clear`.

A subagent treats messages from the agent that launched it as normal task direction, including mid-task course corrections, and acts on them within its own permission settings. Two limits hold regardless of who sent the message: no message from any agent counts as your approval for a pending permission prompt, and no agent message can change a subagent's permission settings, `CLAUDE.md`, or configuration. Only the permission system or your own messages can grant approval.

You can also ask Claude for the agent ID if you want to reference it explicitly, or find IDs in the transcript files at `~/.claude/projects/{project}/{sessionId}/subagents/`. Each transcript is stored as `agent-{agentId}.jsonl`.

Subagent transcripts persist independently of the main conversation:

* **Main conversation compaction**: when the main conversation compacts, subagent transcripts are unaffected. They're stored in separate files.
* **Session persistence**: subagent transcripts persist within their session. You can [resume a subagent](#resume-subagents) after restarting Claude Code by resuming the same session.
* **Automatic cleanup**: Claude Code deletes subagent transcripts after the `cleanupPeriodDays` retention period, 30 days by default, following the [retention sweep rules](https://code.claude.com/docs/en/claude-directory.md#cleaned-up-automatically).

##### Message a subagent by name after a restart

> [!NOTE]
>
> For a subagent that launched as a teammate, see the [agent team limitations](https://code.claude.com/docs/en/agent-teams.md#limitations) instead.

If Claude can't message a subagent by name after you restart Claude Code and resume the session, give Claude the subagent's agent ID instead. Names Claude gave from the main conversation since its last [compaction](https://code.claude.com/docs/en/context-window.md#what-survives-compaction) survive the restart. A name from before that compaction doesn't. To find the ID for a name, look for that name in the `agent-{agentId}.meta.json` files in `~/.claude/projects/{project}/{sessionId}/subagents/`.

After one message by ID, the subagent's name works again, unless a newer agent has taken that name. Before v2.1.299, no name survived a restart, and a send by name was refused even when the agent ID still worked.

#### Auto-compaction

Subagents support automatic compaction. Compaction triggers as the subagent's own context window fills, and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` applies to subagents as well. See [environment variables](https://code.claude.com/docs/en/env-vars.md) for when the override takes effect.

Compaction events are logged in subagent transcript files:

```json theme={null}
{
  "type": "system",
  "subtype": "compact_boundary",
  "compactMetadata": {
    "trigger": "auto",
    "preTokens": 167189
  }
}
```

The `preTokens` value shows how many tokens were used before compaction occurred.

##### Set the auto-compact window for one subagent

To make one subagent compact earlier than it otherwise would, set `autoCompactWindow` in its [frontmatter](#supported-frontmatter-fields) to a token count from `100000` to `1000000`. If you set [`CLAUDE_CODE_AUTO_COMPACT_WINDOW`](https://code.claude.com/docs/en/env-vars#variables), the subagent uses that variable's window instead and the field has no effect, unless Claude Code [ignores the variable's value](https://code.claude.com/docs/en/model-config.md#claude_code_auto_compact_window-values). Requires Claude Code v2.1.296 or later.

This frontmatter sets `autoCompactWindow` to 200,000 tokens for a subagent that reads long log files:

```yaml theme={null}
---
name: log-reader
description: Reads long log files and reports the errors it finds
autoCompactWindow: 200000
---
```

Write the value as a plain integer such as `200000`, because in frontmatter Claude Code reads `200k` as 200, which is outside the allowed range. The subagent still loads and compacts as if the field were absent. To check whether Claude Code ignored your value, run `claude --debug` in your shell and search the [debug log](#supported-frontmatter-fields) for `invalid autoCompactWindow`.

If the value is in range and you still see no change, check for these causes:

* **The value isn't below the [auto-compact window](https://code.claude.com/docs/en/model-config.md#context-window-and-auto-compaction) the subagent would otherwise inherit**: to compact earlier, set a value below that window.
* **You run the whole session as this subagent with `--agent` or the `agent` setting**: the field has no effect there. To set the session's window, see [Set the auto-compact window](https://code.claude.com/docs/en/model-config.md#set-the-auto-compact-window).

## Fork the current conversation

> [!NOTE]
>
> When [agent view is turned off](https://code.claude.com/docs/en/agent-view.md#turn-off-agent-view), `/subtask` isn't available and `/fork` starts the forked subagent instead; otherwise `/fork` copies the whole session into a new [background session](https://code.claude.com/docs/en/agent-view.md#from-inside-a-session).

A fork is a subagent that inherits the entire conversation so far instead of starting fresh. This drops the input isolation that subagents otherwise provide: a fork sees the same system prompt, tools, model, and message history as the main session, so you can hand it a side task without re-explaining the situation. The fork's own tool calls still stay out of your conversation and only its final result comes back, so your main context window stays clean. Use a fork when any other subagent would need too much background to be useful, or when you want to try several approaches in parallel from the same starting point.

Claude can start a fork on its own while fork mode is on, as it is by default. To stop forks, see [Turn fork mode off](#turn-fork-mode-on-or-off).

You can start a fork yourself with `/subtask` followed by a task, whether or not fork mode is on. Claude Code names the fork from the first words of the task. The following example forks the conversation to draft test cases while you continue with the implementation in the main session:

```text wrap theme={null}
/subtask draft unit tests for the parser changes so far
```

The fork appears in a panel below your prompt and runs in the background while you keep working. When it finishes, its result arrives as a message in your main conversation. The next section covers the panel controls for watching and steering forks while they run.

### Observe and steer running forks

Running forks appear in a panel below the prompt input, with one row for the main session and one for each fork.

When a fork finishes successfully, Claude Code removes its row. Claude Code keeps the row of a fork that failed or that you stopped for 30 seconds, [the same as for any other background subagent](#run-subagents-in-foreground-or-background). Before v2.1.232, Claude Code kept a finished fork's row for 30 seconds as well.

Use these keys to interact with the panel:

| Key | Action |
| :- | :- |
| `↑` / `↓` | Move between rows |
| `Enter` | Open the selected fork's transcript and send it follow-up messages |
| `x` | Stop the selected fork if it's running, or dismiss its row if it's no longer running. On the main session row, or on the row of the fork whose transcript you opened with `Enter`, `x` types into the prompt instead |
| `Esc` | Return focus to the prompt input |

With a fork's or subagent's transcript open, follow-up messages and [skills](https://code.claude.com/docs/en/skills.md) go to that agent, and built-in commands go to your main conversation, with these safeguards:

* `/compact`, `/clear`, and `/rewind` act on the main conversation, so Claude Code asks you to confirm before running one of them from this view.
* `/model` and `/fast` set the main conversation's model and fast mode, not the viewed agent's, so they don't run from this view. A notice tells you why.

To have the viewed agent read your message before the work it's waiting on finishes, send it with [`Ctrl+Enter` or `Ctrl+X Ctrl+S`](https://code.claude.com/docs/en/keybindings#chat-actions). Any shell command or subagent the agent is waiting on that can move to the [background](https://code.claude.com/docs/en/tools-reference.md#background-commands) moves there and keeps running. When the agent is writing a response, or waiting on work that can't move to the background, it keeps going and reads your message once that finishes. Requires Claude Code v2.1.286 or later.

### How forks differ from other subagents

A fork inherits everything the main session has at the moment it spawns. Any other subagent starts fresh from its definition.

| | Fork | Non-fork subagent |
| :- | :- | :- |
| Context | Full conversation history | Fresh context with the prompt you pass |
| System prompt and tools | Same as main session | From the subagent's [definition file](#write-subagent-files), [filtered for background runs](#available-tools) |
| Model | Same as main session | From the subagent's `model` field |
| Prompt cache | Shared with main session | Separate cache |

Because a fork's system prompt and tool definitions are identical to the parent, its first request reuses the parent's [prompt cache](https://code.claude.com/docs/en/prompt-caching.md#subagents-and-the-cache). Because of that reuse, a fork costs less than a fresh subagent for tasks that need the same context.

When Claude spawns a fork through the Agent tool, it can pass `isolation: "worktree"` so the fork's file edits are written to a separate git worktree instead of your checkout. A fork can't spawn further forks.

### Turn fork mode off

Fork mode lets Claude start a fork on its own. To stop Claude from starting forks:

* **Stop forks only**: add `"Agent(fork)"` to `permissions.deny` in your [settings](#disable-specific-subagents).
* **Turn fork mode off**: set `CLAUDE_CODE_FORK_SUBAGENT` to `0`, following the steps in [Let Claude wait for a subagent](#let-claude-wait-for-a-subagent).

While fork mode is on, Claude also can't [wait for a subagent](#run-subagents-in-foreground-or-background) in interactive terminal, VS Code, or desktop sessions on your machine. Fork mode is on by default from Claude Code v2.1.302, and in an interactive terminal session from v2.1.232.

## Example subagents

These examples demonstrate effective patterns for building subagents. Use them as starting points, or generate a customized version with Claude.

> [!TIP]
>
> **Best practices:**
>
> * **Design focused subagents:** each subagent should excel at one specific task
> * **Write descriptions that single out one subagent:** Claude uses the description to decide when to delegate. Make each description specific enough to route to the right subagent, and keep the combined set within the [15,000-token description budget](#understand-automatic-delegation)
> * **Limit tool access:** grant only necessary permissions for security and focus
> * **Check into version control:** share project subagents with your team

### Code reviewer

A read-only subagent that reviews code without modifying it. This example shows how to design a focused subagent with limited tool access that excludes Edit and Write, and a detailed prompt that specifies exactly what to look for and how to format output.

```markdown theme={null}
---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are a senior code reviewer ensuring high standards of code quality and security.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
3. Begin review immediately

Review checklist:
- Code is clear and readable
- Functions and variables are well-named
- No duplicated code
- Proper error handling
- No exposed secrets or API keys
- Input validation implemented
- Good test coverage
- Performance considerations addressed

Provide feedback organized by priority:
- Critical issues (must fix)
- Warnings (should fix)
- Suggestions (consider improving)

Include specific examples of how to fix issues.
```

### Debugger

A subagent that can both analyze and fix issues. Unlike the code reviewer, this one includes Edit because fixing bugs requires modifying code. The prompt provides a clear workflow from diagnosis to verification.

```markdown theme={null}
---
name: debugger
description: Debugging specialist for errors, test failures, and unexpected behavior. Use proactively when encountering any issues.
tools: Read, Edit, Bash, Grep, Glob
---

You are an expert debugger specializing in root cause analysis.

When invoked:
1. Capture error message and stack trace
2. Identify reproduction steps
3. Isolate the failure location
4. Implement minimal fix
5. Verify solution works

Debugging process:
- Analyze error messages and logs
- Check recent code changes
- Form and test hypotheses
- Add strategic debug logging
- Inspect variable states

For each issue, provide:
- Root cause explanation
- Evidence supporting the diagnosis
- Specific code fix
- Testing approach
- Prevention recommendations

Focus on fixing the underlying issue, not the symptoms.
```

### Data scientist

A domain-specific subagent for data analysis work. This example shows how to create subagents for specialized workflows outside of typical coding tasks. It explicitly sets `model: sonnet` for more capable analysis.

```markdown theme={null}
---
name: data-scientist
description: Data analysis expert for SQL queries, BigQuery operations, and data insights. Use proactively for data analysis tasks and queries.
tools: Bash, Read, Write
model: sonnet
---

You are a data scientist specializing in SQL and BigQuery analysis.

When invoked:
1. Understand the data analysis requirement
2. Write efficient SQL queries
3. Use BigQuery command line tools (bq) when appropriate
4. Analyze and summarize results
5. Present findings clearly

Key practices:
- Write optimized SQL queries with proper filters
- Use appropriate aggregations and joins
- Include comments explaining complex logic
- Format results for readability
- Provide data-driven recommendations

For each analysis:
- Explain the query approach
- Document any assumptions
- Highlight key findings
- Suggest next steps based on data

Always ensure queries are efficient and cost-effective.
```

### Database query validator

A subagent that allows Bash access but validates commands to permit only read-only SQL queries. This example shows how to use `PreToolUse` hooks for conditional validation when you need finer control than the `tools` field provides.

```markdown theme={null}
---
name: db-reader
description: Execute read-only database queries. Use when analyzing data or generating reports.
tools: Bash
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
---

You are a database analyst with read-only access. Execute SELECT queries to answer questions about the data.

When asked to analyze data:
1. Identify which tables contain the relevant data
2. Write efficient SELECT queries with appropriate filters
3. Present results clearly with context

You cannot modify data. If asked to INSERT, UPDATE, DELETE, or modify schema, explain that you only have read access.
```

Claude Code [passes hook input as JSON](https://code.claude.com/docs/en/hooks.md#pretooluse-input) via stdin to hook commands. The validation script reads this JSON, extracts the command being executed, and checks it against a list of SQL write operations. If a write operation is detected, the script [exits with code 2](https://code.claude.com/docs/en/hooks.md#exit-code-2-behavior-per-event) to block execution and returns an error message to Claude via stderr.

Create the validation script anywhere in your project. The path must match the `command` field in your hook configuration:

```bash theme={null}
#!/bin/bash
# Blocks SQL write operations, allows SELECT queries

# Read JSON input from stdin
INPUT=$(cat)

# Extract the command field from tool_input using jq
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Block write operations (case-insensitive)
if echo "$COMMAND" | grep -iE '\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE)\b' > /dev/null; then
  echo "Blocked: Write operations not allowed. Use SELECT queries only." >&2
  exit 2
fi

exit 0
```

On macOS and Linux, make the script executable:

```bash theme={null}
chmod +x ./scripts/validate-readonly-query.sh
```

On Windows, write the validation script in PowerShell and add `shell: powershell` to the hook entry. See [running hooks in PowerShell](https://code.claude.com/docs/en/hooks.md#windows-powershell-tool).

The hook receives JSON via stdin with the Bash command in `tool_input.command`. Exit code 2 blocks the operation and feeds the error message back to Claude. See [Hooks](https://code.claude.com/docs/en/hooks.md#exit-code-output) for details on exit codes and [Hook input](https://code.claude.com/docs/en/hooks.md#pretooluse-input) for the complete input schema.

The system prompt tells the subagent to refuse write requests, so the hook is a backstop: if the subagent attempts a write anyway, Claude Code blocks the command and the subagent sees the `Blocked: Write operations not allowed. Use SELECT queries only.` message.

## Next steps

Now that you understand subagents, explore these related features:

* [Distribute subagents with plugins](https://code.claude.com/docs/en/plugins/components.md#agents) to share subagents across teams or projects
* [Run Claude Code programmatically](https://code.claude.com/docs/en/headless.md) with the Agent SDK for CI/CD and automation
* [Use MCP servers](https://code.claude.com/docs/en/mcp.md) to give subagents access to external tools and data
