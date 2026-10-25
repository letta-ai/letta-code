> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Tools reference

> Complete reference for the tools Claude Code can use, including permission requirements and per-tool behavior.

Claude Code has access to a set of built-in tools that help it understand and modify your codebase. The tool names are the exact strings you use in [permission rules](https://code.claude.com/docs/en/permissions.md#tool-specific-permission-rules), [subagent tool lists](https://code.claude.com/docs/en/sub-agents.md), and [hook matchers](https://code.claude.com/docs/en/hooks.md).

To control which tools Claude can use and when it asks first, configure [permission rules](https://code.claude.com/docs/en/permissions.md#tool-specific-permission-rules) in your settings, [hooks](https://code.claude.com/docs/en/hooks.md), or a [subagent's tool list](https://code.claude.com/docs/en/sub-agents.md#supported-frontmatter-fields). See [Configure tools with permission rules and hooks](#configure-tools-with-permission-rules-and-hooks) for each place that accepts a tool name.

To add custom tools, connect an [MCP server](https://code.claude.com/docs/en/mcp.md). To extend Claude with reusable prompt-based workflows, write a [skill](https://code.claude.com/docs/en/skills.md), which runs through the existing `Skill` tool rather than adding a new tool entry.

> [!NOTE]
>
> In [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode), a classifier decides most permission prompts instead of you. The `Permission required` column shows whether the tool prompts in [Manual mode](https://code.claude.com/docs/en/permission-modes.md) for paths inside the working directory. File-access tools marked No, including `Read`, `Grep`, and `Glob`, still prompt for paths outside the [working directory and additional directories](https://code.claude.com/docs/en/permissions.md#working-directories). `Bash` is marked Yes but runs a built-in set of [read-only commands](https://code.claude.com/docs/en/permissions.md#read-only-commands) without prompting.

| Tool | Description | Permission required |
| :- | :- | :- |
| `Agent` | Spawns a [subagent](https://code.claude.com/docs/en/sub-agents.md) with its own context window to handle a task. With [agent teams](https://code.claude.com/docs/en/agent-teams.md) enabled, a call that carries a `name` can launch a [teammate](https://code.claude.com/docs/en/agent-teams.md#how-claude-starts-agent-teams) instead. See [Agent tool behavior](#agent-tool-behavior) | No |
| `Artifact` | Publishes an HTML or Markdown file as an [artifact](https://code.claude.com/docs/en/artifacts.md): a private, interactive page on claude.ai. You can share it with a public link, or inside your organization on Team and Enterprise plans, where public sharing requires an Owner to [enable it](https://code.claude.com/docs/en/artifacts.md#control-public-sharing). Requires a Pro, Max, Team, or Enterprise plan and `/login` authentication; see [Availability](https://code.claude.com/docs/en/artifacts.md#availability) | Yes |
| `AskUserQuestion` | Asks multiple-choice questions to gather requirements or clarify ambiguity. Questions stay open until you answer them by default. See [AskUserQuestion tool behavior](#askuserquestion-tool-behavior) | No |
| `Bash` | Executes shell commands in your environment. See [Bash tool behavior](#bash-tool-behavior) | Yes |
| `CronCreate` | Schedules a recurring or one-shot prompt within the current session. Tasks are session-scoped and restored on `--resume` or `--continue` if unexpired. See [session-scoped scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks.md) | No |
| `CronDelete` | Cancels a session-scoped scheduled task by ID | No |
| `CronList` | Lists all session-scoped scheduled tasks | No |
| `Edit` | Makes targeted edits to specific files. See [Edit tool behavior](#edit-tool-behavior) | Yes |
| `EndConversation` | Ends the session, in rare cases of sustained abusive input or when you ask Claude to demonstrate the tool. See [EndConversation tool behavior](#endconversation-tool-behavior) | No |
| `EnterPlanMode` | Switches to plan mode to design an approach before coding | No |
| `EnterWorktree` | Creates an isolated [git worktree](https://code.claude.com/docs/en/worktrees.md) and switches into it. Pass a `path` to switch into an existing worktree instead of creating a new one. On first entry the target may be a worktree of the current repository or, in a multi-repo workspace, of a repository nested inside it. Before v2.1.203, a nested repository's worktree was rejected. A `path` outside `.claude/worktrees/` prompts for your approval before entering, since it moves the session's working directory and write access to that location. New-worktree creation and paths under `.claude/worktrees/` don't prompt. Before v2.1.206, Claude entered paths outside `.claude/worktrees/` without a prompt. From within a worktree session, or from a subagent with a pinned working directory such as [`isolation: worktree`](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields), only the `path` form is available and the target must be under `.claude/worktrees/` of the session's repository | Yes |
| `ExitPlanMode` | Presents a plan for approval and exits plan mode | Yes |
| `ExitWorktree` | Exits a worktree session and returns to the original directory. Not available to subagents that already run in their own working directory, such as with [`isolation: worktree`](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields) | No |
| `Glob` | Finds files based on pattern matching. Absent by default on macOS, Linux, and WSL. See [Glob tool behavior](#glob-tool-behavior) | No |
| `Grep` | Searches for patterns in file contents. Absent by default on macOS, Linux, and WSL. See [Grep tool behavior](#grep-tool-behavior) | No |
| `ListAgents` | Lists the agents Claude can message with `SendMessage`: subagents in the session, [agent team](https://code.claude.com/docs/en/agent-teams.md) teammates, your other local Claude Code sessions, and, while this session is connected to [Remote Control](https://code.claude.com/docs/en/remote-control.md), your [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md) and your Remote Control sessions on other machines. Backs the `/list-agents` command. See [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md). Requires Claude Code v2.1.224 or later, and appears only in sessions where [cross-session messaging is enabled](https://code.claude.com/docs/en/cross-session-messaging.md#availability). Teammate rows and the first line showing this session's own name require v2.1.239 or later | No |
| `ListMcpResourcesTool` | Lists resources exposed by connected [MCP servers](https://code.claude.com/docs/en/mcp.md), leaving out [MCP Apps UI resources](https://code.claude.com/docs/en/mcp.md#reference-mcp-resources), which are pages for a host application to render | No |
| `LSP` | Code intelligence via language servers: jump to definitions, find references, report type errors and warnings. See [LSP tool behavior](#lsp-tool-behavior) | No |
| `Monitor` | Runs a command in the background and feeds each output line back to Claude, so it can react to log entries, file changes, or polled status mid-conversation. Can also open a WebSocket and treat each incoming message as an event. See [Monitor tool](#monitor-tool) | Yes |
| `NotebookEdit` | Modifies Jupyter notebook cells. See [NotebookEdit tool behavior](#notebookedit-tool-behavior) | Yes |
| `PowerShell` | Executes PowerShell commands natively. See [PowerShell tool](#powershell-tool) for availability | Yes |
| `PushNotification` | Sends a desktop notification, and a phone push when [Remote Control](https://code.claude.com/docs/en/remote-control.md) is connected, so a long-running task or [session-scoped scheduled task](https://code.claude.com/docs/en/scheduled-tasks.md) can reach you when you step away. Push delivery runs through Anthropic-hosted infrastructure, which is not accessible from Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry | No |
| `Read` | Reads the contents of files. See [Read tool behavior](#read-tool-behavior) | No |
| `ReadMcpResourceTool` | Reads a specific MCP resource by URI | No |
| `RemoteTrigger` | Creates, updates, runs, and lists [cloud scheduled tasks](https://code.claude.com/docs/en/routines.md), formerly routines, on claude.ai. Backs the `/schedule` command. The [`RemoteTrigger` input reference](https://code.claude.com/docs/en/agent-sdk/typescript#remotetrigger) documents every action and the organization policies that remove the tool. Cloud scheduled tasks live on claude.ai and require a Pro, Max, Team, or Enterprise plan. This tool is therefore not accessible from Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry | No |
| `ReportFindings` | Reports code-review findings as a structured list, with a file, summary, and failure scenario per finding, so Claude Code can render them instead of printing them as text. Claude calls it when active code-review instructions tell it to. A finding can also carry an optional `category` slug, such as `correctness` or `test-coverage`, shown next to the file location in the rendered list | No |
| `ScheduleWakeup` | Reschedules the next iteration of a [self-paced `/loop`](https://code.claude.com/docs/en/scheduled-tasks#let-claude-choose-the-interval). Claude calls this at the end of each iteration to pick when the next one runs, between one minute and one hour out; you don't call it directly. To end the loop instead, Claude calls it with `stop: true`, which cancels the pending wakeup. The pending wakeup appears in `session_crons` in [Stop hook input](https://code.claude.com/docs/en/hooks.md#stop-input) | No |
| `SendFeedback` | Drafts a feedback report about Claude Code, covering a product problem or Claude's own behavior in the session, and queues it on your machine for you to review. Claude Code sends nothing until you choose to send the draft. See [SendFeedback tool behavior](#sendfeedback-tool-behavior). Requires Claude Code v2.1.238 or later | No |
| `SendMessage` | Sends a message to another agent: an [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate, a [subagent it resumes](https://code.claude.com/docs/en/sub-agents.md#resume-subagents) by agent ID or name, or one of your other Claude Code sessions, on this machine or beyond it. Messaging other sessions requires Claude Code v2.1.224 or later. [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md) covers which sessions Claude can reach, [what a message looks like when it arrives](https://code.claude.com/docs/en/cross-session-messaging.md#what-a-message-looks-like), and [how Claude gets a notice when another session goes idle](https://code.claude.com/docs/en/cross-session-messaging.md#get-a-notice-when-another-session-goes-idle). Claude can include an optional `summary` input, typically 5-10 words, that Claude Code shows as a one-line preview. When Claude omits it on a [plain-text message](https://code.claude.com/docs/en/cross-session-messaging.md#limitations), Claude Code uses the first line of the message as the summary. Claude Code truncates a summary longer than 200 characters with an ellipsis | No |
| `SendUserFile` | Sends files from the session to you with an optional caption, so a generated report, diagram, screenshot, or built artifact reaches your device instead of only being mentioned in the transcript. The optional `display` input controls presentation: `render` opens the file inline in the client, `attach` shows a download card only, and when unset the client decides by file type. Available when a [Remote Control](https://code.claude.com/docs/en/remote-control.md) client is connected or in a [cloud session](https://code.claude.com/docs/en/claude-code-on-the-web.md). Delivery runs through Anthropic-hosted infrastructure, so the tool is not available on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry | No |
| `ShareOnboardingGuide` | Uploads `ONBOARDING.md` and returns a share link teammates can open in Claude Code. Called from `/team-onboarding` after the guide is written. Available to claude.ai subscribers on Team and Enterprise plans | Yes |
| `Skill` | Executes a [skill](https://code.claude.com/docs/en/skills.md#control-who-invokes-a-skill) within the main conversation | Yes |
| `SubagentHandback` | Delivers a subagent's final report to whichever conversation receives that subagent's result. Provided only in [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode), to subagents that the Agent tool runs locally other than [forks](https://code.claude.com/docs/en/sub-agents.md#fork-the-current-conversation), and available in the terminal CLI, IDE extensions, cloud sessions, and the Agent SDK; the classifier reviews the report before it's delivered. Requires Claude Code v2.1.271 or later | No |
| `TaskCreate` | Creates a new task in the task list. Provided by default only on the models listed under [Task tool availability](#task-tool-availability), and on other models when you opt in | No |
| `TaskGet` | Retrieves full details for a specific task. Provided by default only on the models listed under [Task tool availability](#task-tool-availability), and on other models when you opt in | No |
| `TaskList` | Lists all tasks with their current status. Provided by default only on the models listed under [Task tool availability](#task-tool-availability), and on other models when you opt in | No |
| `TaskOutput` | Removed in v2.1.277. Previously retrieved output from a background task; Claude reads a background task's [output file](https://code.claude.com/docs/en/interactive-mode.md#how-backgrounding-works) with `Read` instead | No |
| `TaskStop` | Stops a running background task by ID. It also accepts an [agent-team teammate](https://code.claude.com/docs/en/agent-teams.md) or a named background agent by agent ID or name. When no task matches the ID, the error lists the running background agents by ID and description, including agents that another agent spawned | No |
| `TaskUpdate` | Updates task status, dependencies, details, or deletes tasks. Provided by default only on the models listed under [Task tool availability](#task-tool-availability), and on other models when you opt in | No |
| `TodoWrite` | Manages the session task checklist. Disabled by default in favor of `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`. Set `CLAUDE_CODE_ENABLE_TASKS=0` to re-enable it in [sessions that have the task-tracking tools](#task-tool-availability) | No |
| `ToolSearch` | Searches for and loads deferred tools when [tool search](https://code.claude.com/docs/en/mcp.md#scale-with-mcp-tool-search) is enabled | No |
| `WaitForMcpServers` | Waits for one or more [MCP servers](https://code.claude.com/docs/en/mcp.md) that are still connecting in the background, so a request can use their tools without restarting the session. Claude calls it when a needed server isn't connected yet. Only appears when [tool search](https://code.claude.com/docs/en/mcp.md#scale-with-mcp-tool-search) is disabled, since `ToolSearch` handles the wait when it's enabled | No |
| `WebFetch` | Fetches content from a specified URL. See [WebFetch tool behavior](#webfetch-tool-behavior) | Yes |
| `WebSearch` | Performs web searches. See [WebSearch tool behavior](#websearch-tool-behavior) | Yes |
| `Workflow` | Runs a [dynamic workflow](https://code.claude.com/docs/en/workflows.md): a script that orchestrates many subagents in the background and returns one consolidated result | Yes |
| `Write` | Creates or overwrites files. See [Write tool behavior](#write-tool-behavior) | Yes |

## Configure tools with permission rules and hooks

For the most part, Claude decides when to use these tools and you don't need to name them yourself when interacting with Claude. You reference tool names directly when defining permissions and other configuration:

* in [`permissions.allow`](https://code.claude.com/docs/en/settings-reference#permissions-allow) and [`permissions.deny`](https://code.claude.com/docs/en/settings-reference#permissions-deny) in settings, and the `/permissions` interface
* in the `--allowedTools` and `--disallowedTools` [CLI flags](https://code.claude.com/docs/en/cli-reference.md)
* in the Agent SDK's [`allowedTools` and `disallowedTools`](https://code.claude.com/docs/en/agent-sdk/permissions#allow-and-deny-rules) options
* in a [skill's `allowed-tools`](https://code.claude.com/docs/en/skills#frontmatter-reference) frontmatter
* in a hook's [`if` condition](https://code.claude.com/docs/en/hooks-guide#filter-by-tool-name-and-arguments-with-the-if-field)

All of these accept the same rule format, `ToolName(specifier)`. The specifier depends on the tool, and several tools share a format:

| Rule format | Applies to | Details |
| :- | :- | :- |
| `Bash(npm run *)` | Bash, Monitor | [Command pattern matching](https://code.claude.com/docs/en/permissions.md#bash) |
| `PowerShell(Get-ChildItem *)` | PowerShell | [Command pattern matching](https://code.claude.com/docs/en/permissions.md#powershell) |
| `Read(~/secrets/**)` | Read, Grep, Glob, LSP | [Path pattern matching](https://code.claude.com/docs/en/permissions.md#read-and-edit) |
| `Edit(/src/**)` | Edit, Write, NotebookEdit | [Path pattern matching](https://code.claude.com/docs/en/permissions.md#read-and-edit) |
| `Skill(deploy *)` | Skill | [Skill name matching](https://code.claude.com/docs/en/skills.md#restrict-claude’s-skill-access) |
| `Agent(Explore)` | Agent | [Subagent type matching](https://code.claude.com/docs/en/permissions.md#agent-subagents) |
| `WebFetch(domain:example.com)` | WebFetch | [Domain matching](https://code.claude.com/docs/en/permissions.md#webfetch) |
| `WebSearch` | WebSearch | No specifier; allow or deny the tool as a whole |

Tools not listed here, such as `ExitPlanMode` or `ShareOnboardingGuide`, accept only the bare tool name with no specifier.

An `Edit(...)` allow rule also grants read access to the same path, so you don't need a matching `Read(...)` rule. A `Read(...)` deny rule also blocks the Edit and Write tools on the same path, including creating a new file there, because both tools change content Claude has to be able to read back. For the Write tool, the `Read` deny check requires Claude Code v2.1.228 or later.

Hook `matcher` fields use bare tool names, not the parenthesized rule format. See [matcher patterns](https://code.claude.com/docs/en/hooks.md#matcher-patterns) for the matching rules. For the field names each tool passes to `tool_input` in hooks, see the [PreToolUse input reference](https://code.claude.com/docs/en/hooks.md#pretooluse-input).

## Agent tool behavior

The Agent tool spawns a subagent in a separate context window. The subagent works through its task autonomously, then returns its result to the parent conversation. The parent doesn't see the subagent's intermediate tool calls or outputs, only that final result. The same tool can also launch a teammate or a fork:

* **Teammate**: with [agent teams](https://code.claude.com/docs/en/agent-teams.md) enabled, a call that carries a `name` can launch a [teammate](https://code.claude.com/docs/en/agent-teams.md#how-claude-starts-agent-teams) instead, which reports back through team messages rather than by returning a result
* **Fork**: wherever [fork mode](https://code.claude.com/docs/en/sub-agents.md#turn-fork-mode-on-or-off) is on, the tool can launch a [forked subagent](https://code.claude.com/docs/en/sub-agents.md#fork-the-current-conversation), which inherits the full parent conversation instead of starting fresh

To cap how many turns a subagent runs, set `maxTurns` in the [subagent definition](https://code.claude.com/docs/en/sub-agents.md#supported-frontmatter-fields). When the subagent reaches the limit, Claude Code marks the returned result as partial output, and Claude can [resume the subagent](https://code.claude.com/docs/en/sub-agents.md#resume-subagents) to continue.

Which tools a non-fork subagent can use depends on the `tools` and `disallowedTools` fields in the [subagent definition](https://code.claude.com/docs/en/sub-agents.md):

* **Neither field set**: the subagent inherits every [tool available to subagents](https://code.claude.com/docs/en/sub-agents.md#available-tools).
* **`tools` only**: the subagent gets only the listed tools.
* **`disallowedTools` only**: the subagent gets every parent tool except the listed ones.
* **Both set**: `disallowedTools` takes precedence. A tool listed in both is removed.

In every case, the resolved set is limited to the [tools available to subagents](https://code.claude.com/docs/en/sub-agents.md#available-tools): a tool that isn't available to subagents is never granted, even when listed in `tools`. Where the conditions in the `SubagentHandback` tools-table entry hold, Claude Code also gives the subagent that tool, even if you leave it out of `tools` or list it in `disallowedTools`.

If every entry in a subagent's `tools` list fails to match a usable tool, the Agent tool usually returns an error naming the entries instead of launching the subagent; see [Agent would be spawned with zero tools](https://code.claude.com/docs/en/errors.md#agent-would-be-spawned-with-zero-tools) for the message and how to fix each entry.

Launching the subagent doesn't itself prompt for permission. Claude Code checks the subagent's own tool calls against your permission rules as it runs.

Where you see a subagent's permission prompts depends on whether it runs in the foreground or the background. Claude Code runs subagents in the background by default, apart from the [cases that run in the foreground](https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background).

* **Foreground subagents** show the same permission prompts you would see in the main conversation, at the moment each tool call happens.
* **Background subagents** surface permission prompts in your main session. The prompt names which subagent is asking, and pressing Esc denies that one tool call without stopping the subagent.

To [limit what a subagent can reach](https://code.claude.com/docs/en/sub-agents.md#control-subagent-capabilities) in the first place, narrow its `tools` field, for example by leaving Bash off the list, or set deny rules in your settings.

## AskUserQuestion tool behavior

Claude uses `AskUserQuestion` to ask you multiple-choice questions when it needs a decision or a clarification. Answer by picking an option, or type your own text through the `Other` row or the notes field.

When you answer by typing your own text, Claude Code relays the answer with neutral wording so Claude follows what you wrote, including a request to wait or explain first.

### Question auto-continue timeout

Questions stay open until you answer them. If you want a question you leave unanswered to eventually close and let Claude continue without you, set the [`askUserQuestionTimeout`](https://code.claude.com/docs/en/settings-reference#askuserquestiontimeout) setting to `60s`, `5m`, or `10m`, either in your user `settings.json` or from the **Question auto-continue timeout** row in `/config`.

After a question sits that long with no input, the dialog closes on its own: it submits any options you'd already selected and tells Claude you may be away from your keyboard, so Claude proceeds on its own judgment and can re-ask later. You see a countdown for the last 20 seconds. Press any key to restart the timer. While your terminal reports that its window is focused, the timer doesn't count down.

The timer never starts for a question Claude asks in a [background session](https://code.claude.com/docs/en/agent-view.md), in [screen reader mode](https://code.claude.com/docs/en/accessibility.md), or while the session is connected to [Remote Control](https://code.claude.com/docs/en/remote-control.md). Those questions wait until you answer them. The timeout applies only to `AskUserQuestion`'s multiple-choice questions; permission prompts, including plan approval, never auto-resolve on idle.

## Bash tool behavior

The Bash tool runs each command in a separate process.

### What persists between commands

* When Claude runs `cd` in the main session, the new working directory carries over to later Bash commands as long as it stays inside the project directory or an [additional working directory](https://code.claude.com/docs/en/permissions.md#working-directories) you added with `--add-dir`, `/add-dir`, or `additionalDirectories` in settings. This includes commands Claude runs in response to your later messages.
  * Subagent sessions never carry over working directory changes.
  * If `cd` lands outside those directories, Claude Code resets to the project directory and appends `Shell cwd was reset to <dir>` to the tool result.
  * To disable this carry-over so every Bash command starts in the project directory, set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`.
* Environment variables don't persist. An `export` in one command won't be available in the next.
* Aliases and shell functions defined in your shell startup file are available. At session start, Claude Code sources `~/.zshrc`, `~/.bashrc`, or `~/.profile` depending on your shell, captures the resulting aliases, functions, and shell options, and applies them to every Bash command.

Activate your virtualenv or conda environment before launching Claude Code. To make environment variables persist across Bash commands, set [`CLAUDE_ENV_FILE`](https://code.claude.com/docs/en/env-vars) to a shell script before launching Claude Code, or use a [SessionStart hook](https://code.claude.com/docs/en/hooks.md#persist-environment-variables) to populate it dynamically.

### Timeout and output limits

Each command runs under a timeout, and Claude manages it: when it wants longer than the default for a command, it passes the `timeout` parameter with that call. You never set a per-command timeout.

Two [environment variables](https://code.claude.com/docs/en/env-vars.md) control what Claude gets for a command that runs in the foreground:

* `BASH_DEFAULT_TIMEOUT_MS` — the default when Claude passes no timeout; two minutes out of the box
* `BASH_MAX_TIMEOUT_MS` — with the default, sets the ceiling that caps whatever Claude requests: the effective ceiling is the larger of the two, ten minutes out of the box

In a session that has a [time limit for background commands](#time-limit-for-background-commands), `timeout` on a command that Claude starts in the background instead sets how long the command may run there, with that limit's separate default and maximum. The [PowerShell tool](#powershell-tool) follows the same timeout rules and reads the same two variables.

#### Output limits

Claude Code streams a command's output to a working file as the command runs; a command whose output passes 5 GB is killed. When the command finishes, Claude Code reads the output back from that file, up to the read-back window described below. How much of the output reaches Claude inline depends on whether Claude Code treats the result as a failure:

| Result | What Claude gets |
| :- | :- |
| Valid | Inline up to roughly 30,000 characters by default; past that, the path of a file saved to the session directory and truncated past 64 MiB, plus a preview of up to the first 2,000 characters, and Claude reads or searches the file when it needs the rest |
| Failure | Inline up to roughly 10,000 characters; past that, a head-and-tail excerpt of that size cut from the read-back window, with no file path |

A command that exits 1 counts as a valid result for the Bash tool only when Claude Code recognizes exit code 1 as a benign outcome for that command: `grep`, `rg`, `egrep`, `fgrep`, `find`, `diff`, `test`, and `[`, plus `git diff` and `git grep`. Every other command that exits 1 counts as a failure, even when exit 1 is a benign informational outcome: no matches for `pgrep` and `jq -e`, files that differ for `cmp`.

[`BASH_MAX_OUTPUT_LENGTH`](https://code.claude.com/docs/en/env-vars) sets how many characters of output Claude Code reads back from the working file into a command's result: 30,000 by default, up to a hard ceiling of 150,000. Raise it when your commands routinely overflow that window, such as a verbose build or a full test-suite log. Raising it enlarges the read-back window, which is also the window a failing command's excerpt is cut from. It doesn't raise the inline ceilings: a valid result over the inline ceiling arrives as a file path plus preview regardless of this variable.

To change how much of a valid result Claude receives inline, set the [`bashOutputMaxChars`](https://code.claude.com/docs/en/settings-reference#bashoutputmaxchars) setting instead, up to 128,000 characters. It sizes the inline ceiling and the read-back window together, and Claude Code then ignores `BASH_MAX_OUTPUT_LENGTH`. Requires Claude Code v2.1.261 or later.

### Background commands

For long-running processes such as dev servers or watch builds, Claude can set `run_in_background: true` to start the command as a background task and continue working while it runs. List and stop background tasks with `/tasks`. After you stop one there, or from a connected client such as the desktop app, Claude moves on instead of waiting for it. If a subagent started the command, it's that subagent that moves on.

#### When a background command stops

A command that a [foreground subagent](https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background) started stops when that subagent's run ends, whether it finished, failed, or was interrupted. A command that the main conversation or a background subagent started keeps running after a final response, until it exits, is stopped, or reaches its [time limit](#time-limit-for-background-commands).

While a command that the main conversation started is still running, a run in non-interactive mode with the `-p` flag [stays open after its result](https://code.claude.com/docs/en/headless.md#background-tasks-at-exit) until that command exits or reaches its time limit. A command that a background subagent started is stopped when the run exits.

#### Time limit for background commands

In a session that runs unattended, such as a run with the `-p` flag, an Agent SDK application, a CI job, or a cloud session, background Bash and PowerShell commands have a time limit. A local session you work in from a terminal, the desktop app, or the VS Code extension has no time limit on background commands.

The time limit requires Claude Code v2.1.285 or later. Before v2.1.288, it applied in every session.

The time limit counts from the moment the command enters the background:

* A command that Claude starts in the background gets 30 minutes, or the `timeout` Claude passes with `run_in_background`, up to a maximum of 2 hours
* A command that starts in the foreground and then moves to the background, for example at its timeout, gets 30 minutes from the move

In a run with the `-p` flag whose prompt you pass as text rather than with `--input-format stream-json`, both defaults are 10 minutes instead of 30, because the run [waits for background commands after its result](https://code.claude.com/docs/en/headless.md#background-tasks-at-exit).

When a background command reaches its time limit, Claude Code stops it and tells Claude why, and Claude can start the command again with a longer `timeout` if the work still needs it. The stop notice reads `Background command "<description>" was stopped after reaching its background time limit`.

#### Raise the time limit for background commands

Two [environment variables](https://code.claude.com/docs/en/env-vars.md) raise these limits, for Bash and PowerShell commands alike. Both take milliseconds, and neither can shorten a limit: a lower value leaves the defaults and the 2-hour maximum in place.

* Set `BASH_DEFAULT_TIMEOUT_MS` above `1800000` to replace the 30-minute default with that value, both for commands Claude starts without a `timeout` and for moved commands. In a `-p` run whose prompt you pass as text, any value above `600000` replaces its 10-minute default
* Set `BASH_MAX_TIMEOUT_MS` above `7200000` to raise the 2-hour maximum to that value. Setting `BASH_DEFAULT_TIMEOUT_MS` above `7200000` raises the maximum the same way

#### Foreground commands that move to the background

When a foreground command reaches its timeout without finishing, Claude Code moves it to the background instead of stopping it, unless the command starts with `sleep`. A moved command's [time limit](#time-limit-for-background-commands) counts from the move, and a foreground subagent's moved command still stops when that subagent's run ends.

Setting [`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`](https://code.claude.com/docs/en/env-vars#variables) or running in [bare mode](https://code.claude.com/docs/en/headless.md#start-faster-with-bare-mode) disables auto-backgrounding, so a command that reaches its timeout stops instead.

The result of a command moved to the background states what happened:

* When the timeout triggers the move, the result reports it explicitly: `Command did not complete within its 120s timeout and was moved to the background`, with the seconds matching the timeout that applied, followed by the task ID and the path of the file the output is being written to.
* A `cd`, `pushd`, `popd`, or `chdir` inside a command that is moved to the background never carries over: the result states `Session cwd remains <dir>; directory changes made by the backgrounded command do not apply to subsequent commands.`, so Claude doesn't act on a directory change that didn't happen.

### Memory limit on Linux and WSL

On Linux and WSL, set [`CLAUDE_CODE_TOOL_MEMORY_LIMIT`](https://code.claude.com/docs/en/env-vars#variables) to a size such as `4G` to cap the memory that Bash, PowerShell, and [Monitor](#monitor-tool) tool commands can use, so one runaway build can't take the memory the rest of the session needs. Requires Claude Code v2.1.233 or later. Before v2.1.246, Monitor tool commands ran outside the cap.

* Write the size as a number of bytes or with a `K`, `M`, `G`, or `T` suffix. Set `0`, `off`, `false`, `no`, or `none` to turn the cap off. Claude Code ignores any other value it can't read as a size, such as `4e9`.
* Claude Code counts all of a session's Bash, PowerShell, and Monitor commands against the one cap, not each command on its own.
* Claude Code applies the cap with a memory cgroup. When it can't set the cgroup up, commands run without a cap, and the debug log from `claude --debug` says why.
* After the first process Claude Code starts has turned the cap on, or has turned it off because of an off value or a failed cgroup setup, Claude Code holds that result until you relaunch. To apply a changed or removed value, or a fixed setup, launch `claude` again.
* When commands can't stay under the cap, the kernel kills a command, and nothing in its result names the cap.

Claude Code can also count other kinds of processes it starts against the same limit. Set [`CLAUDE_CODE_TOOL_MEMORY_CGROUP_EXCLUDE`](https://code.claude.com/docs/en/env-vars#variables) to a comma-separated list of the kinds to exempt from the cap; Claude Code applies the cap to every kind not on your list. Set it to `none` to cap every kind, or to `all-new` to cap only Bash, PowerShell, and Monitor tool commands. Requires Claude Code v2.1.246 or later. The kinds you can name:

* `mcp`: local [MCP servers](https://code.claude.com/docs/en/mcp.md)
* `lsp`: [language servers](#lsp-tool-behavior)
* `hooks`: [hook](https://code.claude.com/docs/en/hooks.md) commands
* `plugin`: commands that [plugins](https://code.claude.com/docs/en/plugins/overview.md) run
* `helper`: Claude Code's own helper commands, such as `git`
* `agent`: child Claude Code processes, such as [agent teammates](https://code.claude.com/docs/en/agent-teams.md)

Whatever you list, these rules apply:

* **Unknown names**: Claude Code ignores names it doesn't recognize
* **Variable unset**: Claude Code takes the set of other capped kinds from configuration Anthropic delivers from the server, and that set can change over time, so set the variable when you need a set that doesn't change
* **Permission-gating hooks**: even with every kind capped, Claude Code excludes from the cap a hook that can block or change the outcome of an action, and any MCP server that such a hook calls, so the kernel killing a permission-gating hook can't allow the action it was blocking

## Edit tool behavior

The Edit tool performs exact string replacement. It takes an `old_string` and a `new_string` and replaces the first with the second. It doesn't use regex or fuzzy matching.

These checks must pass for an edit to apply. Before any of them, a path matched by a [`Read` deny rule](https://code.claude.com/docs/en/permissions#tool-specific-permission-rules) is refused, including creating a new file there.

* **Read-before-edit**: Claude reads the file in the current conversation before editing it, and a read cut short with a [`PARTIAL view` notice](#large-files) doesn't count. Claude Opus 4.6, Claude Haiku 4.5, and older models always require the read. Newer models can edit an unread file when reading it wouldn't need a permission prompt and the Read tool is available.
* **Match**: `old_string` must appear in the file exactly as written. A single character of whitespace or indentation difference is enough to miss.
* **Uniqueness**: `old_string` must appear exactly once. When it appears more than once, Claude either supplies a longer string with enough surrounding context to pin down one occurrence, or sets `replace_all: true` to replace them all.

A file that changed on disk after Claude last read it can still be edited when `old_string` matches the current content exactly and unambiguously and Claude Code can read the file without prompting. Matching against the file's current content keeps this safe, and the result notes that the file carries other changes so Claude re-reads it before edits that depend on surrounding content. In any other case, such as a stale `old_string` or one that matches more than once without `replace_all`, Claude reads the file again before editing.

Claude can also edit a file without a separate Read after viewing it with a Bash command such as `cat` or `grep`. Those commands are `cat`, `nl`, `bat`, `batcat`, `head`, `tail`, `sed -n 'X,Yp'`, `grep`, `egrep`, `fgrep`, and `rg`, each run on one file with no pipes or redirects. If the command printed none of the file's text, as when a search matches nothing, the read-before-edit check still applies.

When Claude views a file this way, Claude Code also loads any [subdirectory `CLAUDE.md`](https://code.claude.com/docs/en/memory#how-claude-md-files-load) and [path-scoped rules](https://code.claude.com/docs/en/memory.md#path-specific-rules) that apply to that file. See [Read and Edit permission rules](https://code.claude.com/docs/en/permissions.md#read-and-edit) for which Bash commands your `Read` and `Edit` deny rules cover.

### Non-UTF-8 files

Claude can't use [NotebookEdit](#notebookedit-tool-behavior) on a file that isn't valid UTF-8. The same goes for Edit, unless the file starts with a little-endian UTF-16 byte-order mark. When Claude tries, the tool refuses the change and leaves the file untouched. Refused files include non-ASCII text saved in a legacy encoding such as Windows-1252 or Shift-JIS, binary files, and UTF-8 with an invalid byte sequence.

The tools refuse because they save the whole file back as UTF-8, which would replace every byte they can't decode with the replacement character `U+FFFD`. Instead, the [error Claude receives](https://code.claude.com/docs/en/errors.md#file-is-not-valid-utf-8) tells it to make the change with a shell command that keeps the file's encoding, or to ask you about converting it to UTF-8 first.

Claude can still replace such a file with Write, unless the new content contains `U+FFFD`, the character Read shows Claude in place of bytes it can't decode. That guard stops Claude from writing back the garbled text it read. When Write does replace the file, it saves the new content as UTF-8, so the file's original encoding is lost.

## EndConversation tool behavior

The EndConversation tool ends the current session. Claude uses it only in two situations:

* as a last resort against sustained abusive input, after attempts to redirect the conversation have failed and after a clear warning in an earlier message
* when you explicitly ask to see the tool demonstrated and confirm that you want the session to end

General frustration, profanity, or a task going badly don't qualify, and neither do requests for harmful content, which Claude declines instead of ending the session. Claude Code follows the same approach as claude.ai, which can [end a rare subset of chats](https://www.anthropic.com/research/end-subset-conversations).

After Claude ends an interactive session, the session locks. New prompts and most commands return `Claude ended this conversation. Start a new session (or /clear) to continue.`, and only `/clear`, `/resume`, `/help`, `/exit`, and `/feedback` still run. Claude Code records the end in the session's transcript, so resuming an ended session restores the lock; the session's history isn't deleted.

Resuming an ended session in [non-interactive mode](https://code.claude.com/docs/en/headless.md) with the `-p` flag errors and exits with code 1, so a script doesn't read the ended run as a success.

The tool never prompts for permission, and [PreToolUse hooks](https://code.claude.com/docs/en/hooks.md#pretooluse) don't run for it. While any other tool remains, you can't block it either: [deny and ask rules](https://code.claude.com/docs/en/permissions.md#tool-specific-permission-rules) naming `EndConversation` have no effect, and neither `--disallowedTools` nor a `--tools` list can remove it. The exemption is deliberate: the tool does nothing except end the conversation, never reading or modifying files or data, and a safeguard of this kind holds only if the session it applies to can't turn it off. When your deny rules remove every other tool and also match `EndConversation`, as `"*"` does, Claude Code removes it too rather than leaving it as the only tool, unless an allow rule names `EndConversation` explicitly. A deny list that removes every other tool without matching `EndConversation` leaves it in place.

[Subagents](https://code.claude.com/docs/en/sub-agents.md) never get the tool. Background tasks that share the main conversation's tool list see it, but calling it there ends nothing.

The tool appears only when all of the following are true:

* **Model**: the session's model is Claude Opus 4.8, Claude Sonnet 5, Claude Fable 5, or a later version of one of those families.
* **Surface**: an interactive terminal session, including a `claude` session in an IDE's integrated terminal, which is how the [JetBrains plugin](https://code.claude.com/docs/en/jetbrains.md) runs it. Other surfaces don't include the tool, such as:
  * non-interactive `-p` runs
  * sessions through the [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md) TypeScript and Python packages
  * the [VS Code extension](https://code.claude.com/docs/en/vs-code.md) panel, which bundles its own CLI
  * [GitHub Actions](https://code.claude.com/docs/en/github-actions.md)
  * [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md)
* **Startup mode**: not a [`--bare`](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode) session. Bare mode loads only shell and file tools, so the tool is never registered there.
* **Provider**: not available on [Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock.md), [Claude Platform on AWS](https://code.claude.com/docs/en/claude-platform-on-aws.md), [Google Cloud's Agent Platform](https://code.claude.com/docs/en/google-vertex-ai.md), or [Microsoft Foundry](https://code.claude.com/docs/en/microsoft-foundry.md), or on sessions signed in through a [cloud gateway](https://code.claude.com/docs/en/claude-apps-gateway).

## Glob tool behavior

The Glob tool finds files by name pattern. On Windows, it's part of the default tool set. On macOS, Linux, and WSL, Claude Code leaves Glob and [Grep](#grep-tool-behavior) out of the default tool set, and Claude searches with `find` and `grep` through the Bash tool instead. In Claude's shell those two commands run embedded versions of `bfs` and `ugrep`, and the searches reach your hooks and permission rules as `Bash` calls.

On macOS, Linux, and WSL, you get the Glob and Grep tools back in these cases:

* You name `Glob` or `Grep` in [`--tools` or `--allowedTools`](https://code.claude.com/docs/en/cli-reference#cli-flags) when you start the session, or in the equivalent [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md) options. With `--tools` you get the ones you list, and naming either tool in `--allowedTools` restores both. An allow rule in a settings file doesn't have this effect.
* A permissions [deny rule](https://code.claude.com/docs/en/permissions.md#match-all-uses-of-a-tool), the `--disallowedTools` flag, or [`--restricted`](https://code.claude.com/docs/en/cli-reference#cli-flags) removes `Bash` from the session.
* A [subagent](https://code.claude.com/docs/en/sub-agents.md#available-tools) lists `Glob` or `Grep` in its `tools` field and leaves out `Bash`. The listed tools come back for that subagent only, or for the whole session when it runs as the main session agent through [`--agent`](https://code.claude.com/docs/en/sub-agents#invoke-subagents-explicitly) or the `agent` setting.

Glob supports standard glob syntax including `**` for recursive directory matching:

* `**/*.js` matches all `.js` files at any depth
* `src/**/*.ts` matches all `.ts` files under `src/`
* `*.{json,yaml}` matches `.json` and `.yaml` files in the current directory

Results are sorted by modification time and capped at 100 files. If the cap is hit, Claude sees a truncation flag in the result and can narrow the pattern.

Glob doesn't respect `.gitignore` by default, so it finds gitignored files alongside tracked ones. This differs from [Grep](#grep-tool-behavior), which skips gitignored files. To make Glob respect `.gitignore`, set `CLAUDE_CODE_GLOB_NO_IGNORE=false` before launching Claude Code.

Claude Code decides permission for a Glob call before it checks whether the search directory exists. It still runs the read-permission check for a missing `path` outside the [working directories](https://code.claude.com/docs/en/permissions.md#working-directories), so a permission prompt for a path doesn't mean the path exists.

A `pattern` or `path` value that contains a null byte returns an error asking Claude to remove it.

## Grep tool behavior

The Grep tool searches file contents for patterns. Where [Glob](#glob-tool-behavior) finds files by name, Grep finds lines inside them. On macOS, Linux, and WSL, Grep is absent by default under the same conditions as Glob. See [Glob tool behavior](#glob-tool-behavior) for when both tools are available.

Grep is built on [ripgrep](https://github.com/BurntSushi/ripgrep) and uses ripgrep's regex syntax, not POSIX grep. Patterns that include regex metacharacters need escaping. For example, finding `interface{}` in Go code takes the pattern `interface\{\}`.

A pattern, glob, or file type that ripgrep rejects returns an error that includes ripgrep's diagnostic, so Claude can correct the input and search again. Before v2.1.208, Claude Code reported a rejected input as `No files found` instead of an error, even when the searched-for text existed in the target files.

Three output modes control what comes back:

* `files_with_matches`: file paths only, no line content. This is the default.
* `content`: matching lines with file and line number. When the tool's `offset` parameter points past the last match for a pattern that has matches, Grep returns `No entries at this offset`, so Claude widens or resets the offset instead of concluding the pattern doesn't match.
* `count`: match count per file, followed by a total across all matching files. The total covers every match even when the tool's `head_limit` or `offset` parameters truncate the listed per-file entries.

Claude can scope results by file with the `glob` parameter, such as `**/*.tsx`, or by language with the `type` parameter, such as `py` or `rust`. By default, patterns match within a single line. Claude can set `multiline: true` to match across line boundaries.

Grep respects `.gitignore`, so gitignored files are skipped. To search a gitignored file, Claude passes its path directly.

Claude Code decides permission for a Grep call before it checks whether the search `path` exists. It still runs the read-permission check for a missing `path` outside the [working directories](https://code.claude.com/docs/en/permissions.md#working-directories), so a permission prompt for a path doesn't mean the path exists.

## LSP tool behavior

The LSP tool gives Claude code intelligence from a running language server. After each file edit, it automatically reports type errors and warnings so Claude can fix issues without a separate build step. Claude can also call it directly to navigate code:

* Jump to a symbol's definition
* Find all references to a symbol
* Get type information at a position
* List symbols in a file
* Search for a symbol by name across the workspace
* Find implementations of an interface
* Trace call hierarchies

Claude Code keeps the tool inactive until you install a [code intelligence plugin](https://code.claude.com/docs/en/plugins/code-intelligence.md) for your language. In [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md), Claude Code doesn't start plugin language servers, so the LSP tool stays inactive there. Claude Code takes the language server's configuration from the plugin, and you install the server binary yourself.

Claude Code returns an error result for each LSP call on a file whose language server it can't start.

## Monitor tool

The Monitor tool lets Claude watch something in the background and react when it changes, without pausing the conversation. Ask Claude to:

* Tail a log file and flag errors as they appear
* Poll a PR or CI job and report when its status changes
* Watch a directory for file changes
* Track output from any long-running script you point it at
* Connect to a WebSocket feed and report each message as it arrives

For most watches, Claude writes a small script, runs it in the background, and receives each output line as it arrives. For a server that already pushes events, Claude can open a [WebSocket](#websocket-source) instead of running a script.

You keep working in the same session and Claude interjects when an event arrives.

Every watch Claude starts has a deadline: 5 minutes by default, at most 30 minutes, and at most 10 minutes in a [non-interactive](https://code.claude.com/docs/en/headless.md) run given a single prompt with `-p`.

At the deadline the watch ends. Claude gets one notice, so it can start the watch again if it's still needed.

Stop a monitor by asking Claude to cancel it or by ending the session. When you stop a [subagent](https://code.claude.com/docs/en/sub-agents.md) that started monitors, for example from `/tasks`, those monitors stop with it.

When Monitor runs a command, it uses the same [permission rules as Bash](https://code.claude.com/docs/en/permissions.md#tool-specific-permission-rules), so `allow` and `deny` patterns you have set for Bash apply here too. While [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) is active, Claude Code sets aside allow rules that name `Monitor` itself, along with the other [broad allow rules it drops](https://code.claude.com/docs/en/permission-modes.md#how-the-classifier-evaluates-actions), so the classifier reviews Monitor commands the same way it reviews Bash commands.

The [WebSocket source](#websocket-source) has its own approval prompt, which the classifier also decides in auto mode.

Monitor needs a minimum version or Git Bash in these cases:

* **Minimum version**: on Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry, or with `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set, Monitor requires Claude Code v2.1.310 or later. The requirement applies when [feature-flag fetching](https://code.claude.com/docs/en/env-vars.md#features-that-need-feature-flag-fetching) is off
* **Windows**: the tool is available only when [Git Bash](https://code.claude.com/docs/en/setup.md#set-up-on-windows) is installed

Plugins can declare monitors that start automatically when the plugin is active, instead of asking Claude to start them. See [plugin monitors](https://code.claude.com/docs/en/plugins/components.md#monitors).

### WebSocket source

When a server already pushes events over a WebSocket, Claude can connect to it directly instead of writing a polling script. Each kind of socket activity either becomes an event or ends the watch:

* **Text messages**: each one becomes one event, even when the message spans multiple lines.
* **Binary messages**: not passed through. Claude receives a placeholder line such as `[binary frame, 512 bytes]` instead.
* **Messages larger than 1 MiB**: the watch ends, so subscribe to a filtered feed where one exists.
* **Socket close**: the watch ends and Claude receives the close code.

A WebSocket watch takes a `ws` input in place of `command`, and a single Monitor call can't combine the two. The `ws` input has two fields:

| Field | Required | Description |
| :- | :- | :- |
| `url` | Yes | The endpoint to connect to. Must be a `ws://` or `wss://` URL with no embedded credentials or whitespace, using ASCII characters only |
| `protocols` | No | WebSocket subprotocol names to offer during the handshake. Each entry must be a valid subprotocol token, and the list can't contain duplicates |

The `timeout_ms` deadline applies to a WebSocket watch too: the watch ends at the deadline, and `TaskStop` cancels it early.

Opening a WebSocket prompts for approval; in [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) the classifier decides instead. The prompt doesn't offer an option to skip future prompts for the same host.

Claude Code denies URLs that point at a private, link-local, or cloud-metadata address, including hostnames that resolve to one. It also denies hosts in `sandbox.network.deniedDomains`, and when [`allowManagedDomainsOnly`](https://code.claude.com/docs/en/settings-reference#sandbox-network-allowmanageddomainsonly) is set in managed settings, any host outside the managed allowlist.

## NotebookEdit tool behavior

NotebookEdit modifies a Jupyter notebook one cell at a time, targeting cells by their `cell_id`. It doesn't perform string replacement across the notebook the way [Edit](#edit-tool-behavior) does on plain files.

Three edit modes control what happens to the target cell:

* `replace`: overwrite the cell's source. This is the default.
* `insert`: add a new cell after the target. With no `cell_id`, the new cell goes at the start of the notebook. Requires `cell_type` set to `code` or `markdown`.
* `delete`: remove the target cell.

NotebookEdit refuses a notebook file that doesn't decode as UTF-8, under the [same rule as Edit](#non-utf-8-files), and writes nothing.

Permission rules use the `Edit(...)` path format. A rule like `Edit(notebooks/**)` covers NotebookEdit calls on files in that directory.

## PowerShell tool

The PowerShell tool lets Claude run PowerShell commands natively. On Windows, this means commands run in PowerShell instead of routing through Git Bash. How the tool becomes available depends on your platform:

* **Windows without Git Bash**: the tool is enabled automatically.
* **Windows with Git Bash installed**: the tool is on by default for claude.ai and Console accounts; set `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` to enable it in Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry sessions, or `0` to turn it off.
* **Linux, macOS, and WSL**: the tool is opt-in.

Your [PreToolUse hooks](https://code.claude.com/docs/en/hooks.md#powershell) receive the tool's command string in `tool_input.command`, with the same fields as the Bash tool.

Match `Bash|PowerShell` in hooks that inspect shell commands; the [PowerShell hook input section](https://code.claude.com/docs/en/hooks.md#powershell) explains why matching `Bash` alone is not enough.

### Enable the PowerShell tool

Set `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` in your environment or in `settings.json`:

```json theme={null}
{
  "env": {
    "CLAUDE_CODE_USE_POWERSHELL_TOOL": "1"
  }
}
```

On Windows, set the variable to `0` to turn the tool off. On Linux, macOS, and WSL, the tool requires PowerShell 7 or later: install `pwsh` and ensure it is on your `PATH`.

On Windows, Claude Code auto-detects `pwsh.exe` for PowerShell 7+ with a fallback to `powershell.exe` for PowerShell 5.1. When the tool is enabled, Claude treats PowerShell as the primary shell. The Bash tool remains available for POSIX scripts when Git Bash is installed.

Claude Code spawns PowerShell with `-ExecutionPolicy Bypass` at process scope only, so `.ps1` scripts and module imports work on default Windows installs without changing the machine's policy. Process-scope bypass doesn't override Group Policy `MachinePolicy` or `UserPolicy`, so enterprise policies still apply. To respect the machine's effective execution policy instead, set `CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY=1`.

### Bash deny rules also turn off the PowerShell tool

On Windows with Git Bash installed, denying Bash also turns the PowerShell tool off for the session. This applies to scoped rules such as `Bash(git push *)` as well as a bare `Bash`, and to rules from one of your settings files or `--disallowedTools`. Claude Code does this because a `Bash` rule doesn't restrict the PowerShell tool, which has [its own permission rules](https://code.claude.com/docs/en/permissions.md#powershell). With PowerShell left on, Claude could run there what your rule denies in Bash.

To keep the PowerShell tool on alongside a Bash deny rule, do either of these:

* Set `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` in your environment or in the `env` block of a settings file, as shown in [Enable the PowerShell tool](#enable-the-powershell-tool).
* Add a scoped [`PowerShell` permission rule](https://code.claude.com/docs/en/permissions#powershell) to a settings file, such as a `PowerShell(git push *)` deny rule.

Without one of these, a scoped Bash deny rule leaves the Bash tool available, and Claude Code turns PowerShell off without a warning. A rule that removes the whole Bash tool leaves Claude with no shell tool for the session.

### Shell selection in settings, hooks, and skills

Three additional settings control where PowerShell is used:

* `"defaultShell": "powershell"` in [`settings.json`](https://code.claude.com/docs/en/settings-reference#all-settings): routes interactive `!` commands through PowerShell. Requires the PowerShell tool to be enabled.
* `"shell": "powershell"` on individual [command hooks](https://code.claude.com/docs/en/hooks.md#command-hook-fields): runs that hook in PowerShell. Hooks spawn PowerShell directly, so this works regardless of `CLAUDE_CODE_USE_POWERSHELL_TOOL`.
* `shell: powershell` in [skill frontmatter](https://code.claude.com/docs/en/skills.md#frontmatter-reference): runs `` !`command` `` blocks in PowerShell. Requires the PowerShell tool to be enabled.

PowerShell commands follow the [same main-session working-directory reset behavior](#what-persists-between-commands) as Bash commands, including the `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` environment variable.

PowerShell commands also receive the variables hooks persist through `CLAUDE_ENV_FILE`, under the conditions in [Persisted variables in PowerShell commands](https://code.claude.com/docs/en/hooks.md#persisted-variables-in-powershell-commands). Requires Claude Code v2.1.296 or later.

### Exit code 1 from searches and `git diff` in PowerShell

If a `grep` or `rg` search that matches nothing shows `Error: Exit code 1` when Claude runs it in the PowerShell tool, the search didn't fail. You don't need to do anything. The error can appear when the search is part of a longer command. For example, when `rg` exits with code 1, `rg foo | Out-Null` shows the error and `rg foo` doesn't.

The PowerShell tool can count exit code 1 as a normal result from `grep`, `rg`, `egrep`, `fgrep`, `findstr`, `git grep`, and `git diff`. The searches use exit code 1 to report no matches. From `git diff`, exit code 1 means the files differ. A command that shows the error when Claude runs it [counts as failed](https://code.claude.com/docs/en/skills.md#when-an-injected-command-fails) in a skill with `shell: powershell`.

### Windows encoding and exit codes

* Redirection with `>` and `>>` writes UTF-8 files on PowerShell 5.1
* Claude Code encodes text piped to a native command's standard input as UTF-8
* Claude Code captures error output without ANSI escape sequences
* A command whose child process waits on standard input receives end-of-file instead of hanging
* If `where.exe` finds no match, or `fc.exe` or `diff.exe` finds that the files differ, the result can show `Error: Exit code 1` though the command didn't fail. You don't need to do anything.
* If a `robocopy` exit code from 1 through 7 shows as an error, the copy didn't fail and you don't need to do anything. `robocopy` exits with code 0 through 7 to report a result, such as files copied, and with 8 or higher when it fails.

### Preview limitations

The PowerShell tool has the following known limitations during the preview:

* PowerShell profiles are not loaded
* On Windows, sandboxing is not supported

## Read tool behavior

The Read tool takes a file path and returns the contents with line numbers. Claude is instructed to always pass absolute paths.

Reading an empty file returns a notice that the file exists but its contents are empty, and an `offset` past the last line returns a notice giving the file's line count.

Read handles several file types beyond plain text:

* **Images**: PNG, JPEG, GIF, and WebP files are returned as visual content that Claude can see, not as raw bytes. Claude Code resizes and recompresses large images to fit the model's image size limits before sending them, so Claude may see a downscaled version of a large screenshot.

  If Claude misses fine pixel-level detail in a large image, ask it to crop the region you care about, such as with ImageMagick via Bash, and then read the crop.

  Read refuses an image file larger than 128 MB with an error that tells Claude to resize the image or export a smaller copy, then read that copy. If Claude stops at the error instead of doing so, see [File is too large to read as an image](https://code.claude.com/docs/en/errors.md#file-is-too-large-to-read-as-an-image).
* **PDFs**: Claude reads short `.pdf` files whole. For PDFs longer than 10 pages, it reads in ranges with a `pages` parameter, such as `"1-5"`, up to 20 pages at a time. Page-range reads render pages with `pdftoppm` from poppler-utils, so install it with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian and Ubuntu. On Windows and other platforms, install a poppler build that puts `pdftoppm` on your `PATH`. Without it, a page-range read fails with `pdftoppm is not installed`.
* **Jupyter notebooks**: `.ipynb` files return all cells with their outputs, including code, markdown, and visualizations. A notebook whose cells come to more than 256 KB, or more than the [token limit](#large-files), returns an error instead. Claude Code refuses to read a notebook file over 100 MB; the error tells Claude how to read a portion of the notebook instead, such as a slice of cells, with a shell command.

Read only reads files, not directories. Claude lists directory contents with a shell command such as `ls`.

Read refuses a file whose extension it treats as binary, such as `.xlsx`, `.parquet`, `.heic`, or `.zip`. Claude keeps working after a refusal: the error suggests a skill for that file type if one is available, or else a shell command or script that reads the format. If you [`@`-mention](https://code.claude.com/docs/en/common-workflows#reference-files-and-directories) a file that Read refuses, Claude receives the file's path but not its contents.

### Large files

Claude can read a text file larger than a single Read call returns. By default one call returns at most 25,000 tokens, or the value you set in [`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`](https://code.claude.com/docs/en/env-vars), and refuses a whole file over 256 KB, so Claude reads a larger file in pages with `offset` and `limit`. On Claude Code v2.1.296 or later it can instead read the whole file, or a long line range, in one call by setting `allow_large: true` when it needs to, for example because you asked for the entire file. That read is sized against the room left in the session's [context window](https://code.claude.com/docs/en/context-window.md) instead of the default limits. Images, PDFs, and notebooks keep their limits.

What Claude receives when a read goes over the default limits:

* **Whole file over the token limit**: the first page of the file, with a `PARTIAL view` notice saying how much of the file it received and how to read more with `offset` and `limit`
* **Whole file over 256 KB, or an `offset` or `limit` read over the token limit**: an error telling it to read a portion with `offset` and `limit`, or to search for specific content with [Grep](#grep-tool-behavior) instead

## SendFeedback tool behavior

Claude-drafted feedback is a feedback report about Claude Code that Claude writes for you. It requires Claude Code v2.1.238 or later. Claude Code saves each draft on your machine under `~/.claude/feedback/drafts/`, and nothing reaches Anthropic until you send it. Claude drafts one with the SendFeedback tool when:

* A tool or command keeps failing
* It can't help with something you asked for
* You point out a mistake it made, or it notices one
* You ask it to file feedback

### What you see when Claude drafts

After Claude queues a draft, you see a card above your prompt with the draft's title. Press `1` to review the draft, press `2` twice to send it as written, or press `0` to dismiss it. A dismissed draft stays in your queue. After you dismiss a card, Claude Code asks whether to turn Claude-drafted feedback off. It stops asking once you've declined twice.

By default, you see at most three cards in a session; Anthropic can adjust that limit from the server without a release. After the limit, and whenever you set [`feedbackDrafts`](https://code.claude.com/docs/en/settings-reference#feedbackdrafts) to `quiet`, you see only a count of queued drafts in the prompt footer.

### Review and edit a draft

Run `/feedback` with no argument to open your queue. It lists every queued draft from all your sessions, including drafts whose cards you dismissed or never saw. Select a draft to open it for review, where you can:

* Edit the title, area, and details
* Set **Send transcript** to `yes` or `no`. When the transcript from the session where Claude queued the draft is still available, it starts at `yes`, which sends that conversation to Anthropic; `no` sends the report only
* Send the draft, discard it, or leave it in the queue for later

To write a report yourself instead, press `w` for the standard feedback dialog. `/feedback` with text after it, and `/bug`, open that dialog directly.

### Send a draft

When you send a draft, Claude Code submits it the same way as a `/feedback` report, with the same [retention](https://code.claude.com/docs/en/data-usage.md#feedback-using-the-%2Ffeedback-command), and deletes the draft from your machine. When you send from the card, it shows `✓ Sent`; when you send from the queue, it closes with a receipt ID.

The report carries:

* Your title, area, and details
* Environment info, such as your Claude Code version, operating system, and model
* The IDs of recent API requests
* The conversation transcript, when you left **Send transcript** at `yes` in the review screen. Sending from the card never includes the transcript

Claude Code keeps your working directory in the local draft so it can find the transcript, and doesn't send the directory.

In [organizations with Zero Data Retention](https://code.claude.com/docs/en/zero-data-retention.md#features-disabled-under-zdr), and in organizations with the [HIPAA configuration](https://code.claude.com/docs/en/hipaa-setup.md) applied, Claude Code leaves the SendFeedback tool out of your sessions. If a session in an organization with Zero Data Retention still offers the tool, drafts stay on your machine, and sending fails with `Feedback collection is not available for organizations with custom data retention policies.`

### Discard or keep a draft

When you discard a draft, Claude Code deletes it from your machine. A draft you leave in the queue expires after 30 days, or after [`cleanupPeriodDays`](https://code.claude.com/docs/en/settings-reference#cleanupperioddays) when that's shorter. The queue holds 10 drafts across all your sessions, and when Claude queues an eleventh, Claude Code deletes the oldest. When you run `/exit` with drafts from the session still in the queue, Claude Code asks whether to review them or discard them before exiting.

### Turn Claude-drafted feedback off

Set **Claude-drafted feedback** to `off` in `/config`, which writes the [`feedbackDrafts`](https://code.claude.com/docs/en/settings-reference#feedbackdrafts) setting, or set [`CLAUDE_CODE_SEND_FEEDBACK=0`](https://code.claude.com/docs/en/env-vars) for one session. With either, Claude can't queue drafts. To keep drafting on without cards, set `feedbackDrafts` to `quiet` instead. Administrators can set `feedbackDrafts` in [managed settings](https://code.claude.com/docs/en/managed-settings.md), which takes precedence over your own setting.

### Sessions without Claude-drafted feedback

Claude Code includes the tool in interactive terminal sessions on your own machine that use the Claude API rather than a cloud provider. It leaves the tool out of:

* Non-interactive `-p` runs and [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md) sessions, which have no screen to review the queue on
* [Cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md), which can't write to the queue on your machine
* Sessions on [Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock.md), [Claude Platform on AWS](https://code.claude.com/docs/en/claude-platform-on-aws.md), [Google Cloud's Agent Platform](https://code.claude.com/docs/en/google-vertex-ai.md), or [Microsoft Foundry](https://code.claude.com/docs/en/microsoft-foundry.md)
* Sessions where you set [`CLAUDE_CODE_SEND_FEEDBACK=0`](https://code.claude.com/docs/en/env-vars) or [`DISABLE_FEEDBACK_COMMAND=1`](https://code.claude.com/docs/en/env-vars), set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to any non-empty value, or turned off [feature-flag fetching](https://code.claude.com/docs/en/env-vars.md#features-that-need-feature-flag-fetching)
* Organizations that have turned off product feedback, [organizations with Zero Data Retention](https://code.claude.com/docs/en/zero-data-retention.md#features-disabled-under-zdr), and organizations with the [HIPAA configuration](https://code.claude.com/docs/en/hipaa-setup.md) applied

## Task tool availability

The task-tracking tools, `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, and `TodoWrite`, are available by default only on Opus 4.7, Sonnet 4.6, Haiku 4.5, and earlier models. Wherever the tools are available, you get the four Task tools, or `TodoWrite` instead when you set [`CLAUDE_CODE_ENABLE_TASKS=0`](https://code.claude.com/docs/en/env-vars).

On every other model, Claude Code leaves the tools out unless you opt in. The same applies to a model ID Claude Code doesn't recognize, such as a custom model name served through an [LLM gateway](https://code.claude.com/docs/en/llm-gateway). On newer models, Claude keeps track of multi-step work without a written checklist, and the tools' definitions and reminders take up context. Without the tools, Claude adds nothing to the [task list](https://code.claude.com/docs/en/interactive-mode.md#task-list) while it works.

If you'd like to use these tools on a model that doesn't have them by default, do one of the following:

* Export [`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`](https://code.claude.com/docs/en/env-vars) before you start Claude Code, for example `CLAUDE_CODE_ENABLE_TODO_TOOLS=1 claude`. Claude Code then provides the same tools on every model and every provider
* Name one of the tools in [`--allowedTools`](https://code.claude.com/docs/en/cli-reference#cli-flags), for example `claude --allowedTools TaskCreate`
* List the tools in [`--tools`](https://code.claude.com/docs/en/cli-reference#cli-flags), which restricts the session's built-in tools to the ones it names. Include the tools you want alongside the other built-in tools you use
* In the Agent SDK, the [`allowedTools` and `tools` options](https://code.claude.com/docs/en/agent-sdk/todo-tracking#model-availability) work the same way as the two flags

In [background sessions](https://code.claude.com/docs/en/agent-view.md) and in [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md), Claude Code provides the same tools on every model, listed or not.

The default set described here applies in Claude Code v2.1.268 and later.

### Task-tracking tools in subagents and agent teams

A subagent has the task-tracking tools only when your session has them, whatever model the subagent runs. An in-process [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate has the task-tracking tools when your session does. A [split-pane](https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode) teammate is a separate Claude Code process that [inherits](https://code.claude.com/docs/en/agent-teams.md#permissions) your `--tools` list and deny rules, not `--allowedTools`, so check what you set:

* **No `--tools` list or deny rule, and `CLAUDE_CODE_ENABLE_TODO_TOOLS` unset for the teammate**: the teammate has the task-tracking tools its own model has by default.
* **`CLAUDE_CODE_ENABLE_TODO_TOOLS` exported in your shell**: Claude Code passes the teammate a fixed set of environment variables that doesn't include the one you exported. To set it for the teammate too, start your session by running `claude --settings '{"env":{"CLAUDE_CODE_ENABLE_TODO_TOOLS":"1"}}'` in your shell. The teammate also gets your [`--settings`](https://code.claude.com/docs/en/settings#change-a-setting-for-one-session) value.
* **`--tools` naming the task-tracking tools**: the teammate has them on any model.
* **A task-tracking tool missing from `--tools` or named in a deny rule**: the teammate lacks that tool.

Without the Task tools, an agent coordinates with its team through messages instead of the [shared task list](https://code.claude.com/docs/en/agent-teams.md#assign-and-claim-tasks).

## WebFetch tool behavior

WebFetch takes a URL and a prompt describing what to extract. It fetches the page and converts the response to Markdown when the server returns HTML. For most fetches, it then runs the prompt against the content in a separate model call, and Claude receives the result of that call rather than the raw page. The conversion step is not configurable.

This makes WebFetch lossy by design. The extraction prompt determines what reaches Claude, so a result that says a page doesn't mention something may only mean the prompt didn't ask about it. Ask Claude to fetch again with a more specific prompt, or use `curl` via Bash for the unprocessed page.

A few behaviors shape the response Claude receives:

* WebFetch refuses `localhost` and any other hostname without a dot, such as a bare intranet name, before making a request. The [error it returns](https://code.claude.com/docs/en/errors.md#webfetch-cannot-fetch-localhost) tells Claude to reach local servers with `curl` through Bash instead.
* HTTP URLs are automatically upgraded to HTTPS.
* WebFetch reads up to 100,000 characters of a page's content per call. On Claude Code v2.1.290 or later, the result for a longer page tells Claude how much went unread, so Claude can fetch the next part.
* WebFetch caches each response for 15 minutes by default, so repeated fetches of the same URL return quickly. On Claude Code v2.1.233 or later, set [`CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`](https://code.claude.com/docs/en/env-vars#variables) to change how long WebFetch keeps each response.
* A page that hasn't finished downloading within five minutes, including any redirects WebFetch follows, fails with a deadline error. On Claude Code v2.1.268 or later, set [`CLAUDE_CODE_WEBFETCH_DEADLINE_MS`](https://code.claude.com/docs/en/env-vars#variables) to change the limit, or to `0` to remove it.
* When a URL redirects to a different host, WebFetch returns a text result that names the original URL and the redirect target instead of following it. Claude then fetches the new URL with a second WebFetch call.
* When the extraction step hits an overloaded API, Claude Code retries it with backoff; a fetch that still fails returns an error result.

In Manual and `acceptEdits` [permission modes](https://code.claude.com/docs/en/permission-modes.md), WebFetch prompts before fetching, except for domains your [permission rules](https://code.claude.com/docs/en/permissions.md#manage-permissions) already allow or deny and a built-in set of preapproved documentation domains that fetch without a prompt. Whatever your rules allow, a fetch also passes the [WebFetch domain safety check](https://code.claude.com/docs/en/data-usage.md#webfetch-domain-safety-check) first; that section covers what the check sends and the setting that skips it. The prompt offers three options:

* **Yes**: approves this fetch only. The next WebFetch call prompts again, even for the same domain.
* **Yes, and don't ask again for `<domain>`**: approves the fetch and saves a `WebFetch(domain:...)` allow rule for that domain to `.claude/settings.local.json` for that repository. See [how saved approvals persist](https://code.claude.com/docs/en/permissions.md#permission-system). When your organization sets [`allowManagedPermissionRulesOnly`](https://code.claude.com/docs/en/permissions#managed-only-settings), Claude Code hides this option.
* **No, and tell Claude what to do differently**: rejects the fetch.

To allow a domain in advance without a prompt, add an allow rule like `WebFetch(domain:example.com)`; `WebFetch(domain:*)` allows every domain. The `auto` and `bypassPermissions` [permission modes](https://code.claude.com/docs/en/permissions.md#permission-modes) skip the prompt, except for a domain an explicit `ask` rule matches.

An explicit `WebFetch(domain:...)` rule in `deny`, `ask`, or `allow` takes precedence over the preapproved set, so you can block a preapproved domain or require a prompt for it.

When the URL is a claude.ai [artifact](https://code.claude.com/docs/en/artifacts.md) link, Claude Code can also ask for approval to read the artifact itself. For the cases where it asks, see [Read an artifact shared with you](https://code.claude.com/docs/en/artifacts.md#read-an-artifact-shared-with-you).

WebFetch sets a `User-Agent` header beginning with `Claude-User`, and an `Accept` header that prefers Markdown over HTML so servers that support content negotiation can return Markdown directly.

Sandboxed commands don't inherit WebFetch's built-in set of preapproved documentation domains. To let a sandboxed command reach a domain without a prompt, add the domain to [`allowedDomains`](https://code.claude.com/docs/en/settings-reference#sandbox-network-alloweddomains) or allow it with a `WebFetch(domain:...)` rule, which the [sandbox also honors](https://code.claude.com/docs/en/sandboxing.md#network-isolation). WebFetch never reads the sandbox allowlist in return, so adding a domain to a sandbox or organization network allowlist doesn't stop WebFetch from prompting for it.

### WebFetch availability

On Claude Code v2.1.285 or later, set [`CLAUDE_CODE_DISABLE_WEB_FETCH`](https://code.claude.com/docs/en/env-vars#variables) to `1` to turn WebFetch off.

If you sign in with a Team or Enterprise claude.ai account and don't connect through an [LLM gateway](https://code.claude.com/docs/en/llm-gateway), WebFetch also depends on your organization's policy, which Claude Code requests from `api.anthropic.com` when a session starts. The same goes for a session whose plan Claude Code can't determine, such as one running under a claude.ai token that another app supplied.

If WebFetch is missing from a session, run `/status` in the session. If its `Organization policy` line reports that the policy didn't load and names web fetch among the features that wait for it, Claude Code is withholding WebFetch until it can confirm that your organization allows it. Outside a session, `claude doctor` makes its own request and prints the same line. Once a policy that allows WebFetch loads, the tool returns without a restart.

## WebSearch tool behavior

WebSearch runs a query against Anthropic's [web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) backend and returns result titles and URLs. It doesn't fetch the result pages. To read a page Claude finds in search results, it follows up with [WebFetch](#webfetch-tool-behavior).

The tool may issue up to eight backend searches per call, refining the search internally before returning results. Claude can scope results with `allowed_domains` to include only certain hosts, or `blocked_domains` to exclude them. The two lists can't be combined in a single call.

When the search request hits an overloaded API, Claude Code retries it with backoff; a call that still fails returns an error result.

WebSearch permission rules take no specifier. A bare `WebSearch` entry in `allow` or `deny` is the only form.

The search backend is not configurable. To search with a different provider, add an [MCP server](https://code.claude.com/docs/en/mcp.md) that exposes a search tool.

> [!NOTE]
>
> WebSearch is available on the Claude API, [Claude Platform on AWS](https://code.claude.com/docs/en/claude-platform-on-aws.md), and Microsoft Foundry. On Google Cloud's Agent Platform it works with Opus 4, Sonnet 4, Haiku 4.5, and later models. Amazon Bedrock doesn't expose the server-side web search tool.

### Session search limit

An interactive terminal session has a limit of 200 WebSearch calls. Searches from the main conversation and from [subagents](https://code.claude.com/docs/en/sub-agents.md), such as a parallel research fan-out, count against the same limit.

While a session is at the limit, searches appear in the conversation as calls that did nothing. Claude gets a notice telling it to continue with the information already gathered, say so in its answer, and, if it needs more searches, ask you to raise the limit.

To get more searches, raise the cap, wait for the limit to refill, or start a new conversation:

* **Raise the cap**: set the [`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`](https://code.claude.com/docs/en/env-vars#variables) environment variable to a positive whole number, such as `500`. The cap can be raised but not turned off.
* **Wait for the refill**: on Claude Code v2.1.290 or later, an interactive terminal session's limit refills at about 100 calls per hour. To change the rate, set [`CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR`](https://code.claude.com/docs/en/env-vars#variables) to a number of calls per hour, such as `50`.
* **Start a new conversation**: running [`/clear`](https://code.claude.com/docs/en/commands#all-commands) at the Claude Code prompt also resets the count. If work that can still spawn subagents survives the clear, such as a running workflow, the count carries over instead.

In [non-interactive mode](https://code.claude.com/docs/en/headless.md) with `-p` and in the [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md), the limit applies per turn, not per session. A turn lasts from a message you send until Claude finishes responding. The limit resets when you send the next message after that or start a new `claude -p` run, even with [`--continue` or `--resume`](https://code.claude.com/docs/en/headless#continue-conversations). For more searches, raise [`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`](https://code.claude.com/docs/en/env-vars#variables) or set a refill rate with [`CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR`](https://code.claude.com/docs/en/env-vars#variables).

## Write tool behavior

The Write tool creates a new file or overwrites an existing one with the full content provided. It doesn't append or merge. Write also overwrites an existing file whose bytes don't decode and saves the new content as UTF-8, as described under [non-UTF-8 files](#non-utf-8-files).

Whether Claude must read an existing file in the current conversation before overwriting it depends on the model and the file:

* Claude Opus 4.6, Claude Haiku 4.5, and older models always require the read, so a Write to an unread existing file fails with an error.
* Newer models can overwrite a file they never read this session under the same conditions as [read-before-edit](#edit-tool-behavior): reading it wouldn't need a permission prompt and the Read tool is available.
* Jupyter notebooks, and files Claude has read only partially with a [`PARTIAL view` notice](#large-files), require the read on every model.

This constraint doesn't apply to new files. Before v2.1.228, every model required the read before overwriting an existing file.

Viewing the file with Bash also satisfies this requirement under the same rules described in [Edit tool behavior](#edit-tool-behavior).

For partial changes to an existing file, Claude uses Edit instead of Write.

## Check which tools are available

Your exact tool set depends on your provider, platform, and settings. To check what's loaded in a running session, ask Claude directly:

```text theme={null}
What tools do you have access to?
```

Claude gives a conversational summary. For exact MCP tool names, run `/mcp`.

> [!NOTE]
>
> The [advisor tool](https://code.claude.com/docs/en/advisor.md) is a [server tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) that the API runs, rather than a tool that Claude Code implements. It has no name you can reference in permission rules or hook matchers.

## See also

* [MCP servers](https://code.claude.com/docs/en/mcp.md): add custom tools by connecting external servers
* [Permissions](https://code.claude.com/docs/en/permissions.md): permission system, rule syntax, and tool-specific patterns
* [Subagents](https://code.claude.com/docs/en/sub-agents.md): configure tool access for subagents
* [Hooks](https://code.claude.com/docs/en/hooks-guide.md): run custom commands before or after tool execution
