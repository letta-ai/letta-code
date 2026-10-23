> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# How Claude Code works

> Understand the agentic loop, built-in tools, and how Claude Code interacts with your project.

Claude Code is an agentic assistant that runs in your terminal. While it excels at coding, it can help with anything you can do from the command line: writing docs, running builds, searching files, researching topics, and more.

This guide covers the core architecture, built-in capabilities, and [tips for working effectively](#work-effectively-with-claude-code). For step-by-step walkthroughs, see [Common workflows](https://code.claude.com/docs/en/common-workflows.md). For extensibility features like skills, MCP, and hooks, see [Extend Claude Code](https://code.claude.com/docs/en/features-overview.md).

## The agentic loop

When you give Claude a task, it works through three phases: **gather context**, **take action**, and **verify results**. These phases blend together. Claude uses tools throughout, whether searching files to understand your code, editing to make changes, or running tests to check its work.

![Diagram of the agentic loop: Your prompt leads to Claude gathering context, taking action, verifying results, and repeating until task complete. You can interrupt at any point.](https://mintcdn.com/claude-code/ikqp3_70mqIahteV/images/agentic-loop.svg?fit=max\&auto=format\&n=ikqp3_70mqIahteV\&q=85\&s=4a30fb7ce2815012a9f27c955e2c6bb0)

The loop adapts to what you ask. A question about your codebase might only need context gathering. A bug fix cycles through all three phases repeatedly. A refactor might involve extensive verification. Claude decides what each step requires based on what it learned from the previous step, chaining dozens of actions together and course-correcting along the way.

You're part of this loop too. You can interrupt at any point to steer Claude in a different direction, provide additional context, or ask it to try a different approach. Claude works autonomously but stays responsive to your input.

The agentic loop is powered by two components: [models](#models) that reason and [tools](#tools) that act. Claude Code is the layer around the model that provides the tools and manages the context the model sees. This surrounding layer is what the term agentic harness refers to.

### Models

Claude Code uses Claude models to understand your code and reason about tasks. Claude can read code in any language, understand how components connect, and figure out what needs to change to accomplish your goal. For complex tasks, it breaks work into steps, executes them, and adjusts based on what it learns.

[Multiple models](https://code.claude.com/docs/en/model-config.md) are available with different tradeoffs. Sonnet handles most coding tasks well. Opus provides stronger reasoning for complex architectural decisions. Switch with `/model` during a session or start with `claude --model <name>`.

When this guide says "Claude chooses" or "Claude decides," it's the model doing the reasoning.

### Tools

Tools are what make Claude Code agentic. Without tools, Claude can only respond with text. With tools, Claude can act: read your code, edit files, run commands, search the web, and interact with external services. Each tool use returns information that feeds back into the loop, informing Claude's next decision.

The built-in tools generally fall into five categories, each representing a different kind of agency.

| Category | What Claude can do |
| - | - |
| **File operations** | Read files, edit code, create new files, rename and reorganize |
| **Search** | Find files by pattern, search content with regex, explore codebases |
| **Execution** | Run shell commands, start servers, run tests, use git |
| **Web** | Search the web, fetch documentation, look up error messages |
| **Code intelligence** | See type errors and warnings after edits, jump to definitions, find references (requires [code intelligence plugins](https://code.claude.com/docs/en/plugins/code-intelligence.md)) |

These are the primary capabilities. Claude also has tools for spawning subagents, asking you questions, and other orchestration tasks. See [Tools available to Claude](https://code.claude.com/docs/en/tools-reference.md) for the complete list.

Claude chooses which tools to use based on your prompt and what it learns along the way. When you say "fix the failing tests," Claude might:

1. Run the test suite to see what's failing
2. Read the error output
3. Search for the relevant source files
4. Read those files to understand the code
5. Edit the files to fix the issue
6. Run the tests again to verify

Each tool use gives Claude new information that informs the next step. This is the agentic loop in action.

**Extending the base capabilities:** The built-in tools are the foundation. You can extend what Claude knows with [skills](https://code.claude.com/docs/en/skills.md), connect to external services with [MCP](https://code.claude.com/docs/en/mcp.md), automate workflows with [hooks](https://code.claude.com/docs/en/hooks.md), and offload tasks to [subagents](https://code.claude.com/docs/en/sub-agents.md). These extensions form a layer on top of the core agentic loop. See [Extend Claude Code](https://code.claude.com/docs/en/features-overview.md) for guidance on choosing the right extension for your needs.

## What Claude can access

When you run `claude` in a directory, Claude Code gains access to:

* **Your project.** Files in your directory and subdirectories, plus files elsewhere with your permission.
* **Your terminal.** Any command you could run: build tools, git, package managers, system utilities, scripts. If you can do it from the command line, Claude can too.
* **Your git state.** Current branch, uncommitted changes, and recent commit history.
* **Your [CLAUDE.md](https://code.claude.com/docs/en/memory.md).** A markdown file where you store project-specific instructions, conventions, and context that Claude should know every session. If your repository has an AGENTS.md for other coding agents, Claude [can read that](https://code.claude.com/docs/en/memory.md#agents-md) in place of a CLAUDE.md.
* **[Auto memory](https://code.claude.com/docs/en/memory.md#auto-memory).** Learnings Claude saves automatically as you work, like your preferences. The first 200 lines or 25KB of MEMORY.md, whichever comes first, load at the start of each session.
* **Extensions you configure.** [MCP servers](https://code.claude.com/docs/en/mcp.md) for external services, [skills](https://code.claude.com/docs/en/skills.md) for workflows, [subagents](https://code.claude.com/docs/en/sub-agents.md) for delegated work, and [Claude in Chrome](https://code.claude.com/docs/en/chrome.md) for browser interaction.

Because Claude sees your whole project, it can work across it. When you ask Claude to "fix the authentication bug," it searches for relevant files, reads multiple files to understand context, makes coordinated edits across them, runs tests to verify the fix, and commits the changes if you ask. This is different from inline code assistants that only see the current file.

## Environments and interfaces

The [agentic loop](#the-agentic-loop), [tools](#tools), and capabilities are the same everywhere you use Claude Code. What changes is where the code executes and how you interact with it.

### Execution environments

Claude Code runs in three environments, each with different tradeoffs for where your code executes.

| Environment | Where code runs | Use case |
| - | - | - |
| **Local** | Your machine | Default. Full access to your files, tools, and environment |
| **Cloud** | Anthropic-managed VMs, or [self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments) your organization operates | Offload tasks, work on repos you don't have locally |
| **Remote Control** | Your machine, controlled from a browser | Use the web UI while execution and your files stay local |

### Interfaces

You can access Claude Code through the terminal, the [desktop app](https://code.claude.com/docs/en/desktop.md), [IDE extensions](https://code.claude.com/docs/en/vs-code.md), [claude.ai/code](https://claude.ai/code), [Remote Control](https://code.claude.com/docs/en/remote-control.md), [Slack](https://code.claude.com/docs/en/slack.md), and [CI/CD pipelines](https://code.claude.com/docs/en/github-actions.md). The interface determines how you see and interact with Claude, but the underlying agentic loop is identical. See [Use Claude Code everywhere](https://code.claude.com/docs/en/overview.md#use-claude-code-everywhere) for the full list.

## Work with sessions

Claude Code saves your conversation locally as you work. Each message, tool use, and result is written to a plaintext JSONL file under `~/.claude/projects/`, which enables [rewinding](#undo-changes-with-checkpoints), [resuming, and forking](#resume-or-fork-sessions) sessions. Before Claude makes code changes, it also snapshots the affected files so you can revert if needed. For paths, retention, and how to clear this data, see [application data in `~/.claude`](https://code.claude.com/docs/en/claude-directory#application-data).

**Sessions are independent.** Each new session starts with a fresh context window, without the conversation history from previous sessions. Claude can persist learnings across sessions using [auto memory](https://code.claude.com/docs/en/memory.md#auto-memory), and you can add your own persistent instructions in [CLAUDE.md](https://code.claude.com/docs/en/memory.md).

### Work across branches

Each Claude Code conversation is a session tied to your current directory. The `/resume` picker shows sessions from the current worktree by default, with keyboard shortcuts to widen the list to other worktrees or projects. See [Manage sessions](https://code.claude.com/docs/en/sessions.md#use-the-session-picker) for the full list of picker shortcuts and how name resolution works.

Claude sees your current branch's files. When you switch branches, Claude sees the new branch's files, but your conversation history stays the same. Claude remembers what you discussed even after switching.

Since sessions are tied to directories, you can run parallel Claude sessions by using [git worktrees](https://code.claude.com/docs/en/worktrees.md), which create separate directories for individual branches.

### Resume or fork sessions

Resuming a session with `claude --continue` or `claude --resume` reopens it under the same session ID and appends new messages to the existing conversation. Forking with `--fork-session` or `/branch` copies the history into a new session ID, leaving the original unchanged.

![Diagram of session continuity: resume continues the same session, fork creates a new branch with a new ID.](https://mintcdn.com/claude-code/ikqp3_70mqIahteV/images/session-continuity.svg?fit=max\&auto=format\&n=ikqp3_70mqIahteV\&q=85\&s=04ed0984a58e4127e05b3640265241a3)

For the resume flags, the `/resume` picker, naming, and what happens when the same session is open in two terminals, see [Manage sessions](https://code.claude.com/docs/en/sessions.md).

### The context window

Claude's context window holds your conversation history, file contents, command outputs, [CLAUDE.md](https://code.claude.com/docs/en/memory.md), [auto memory](https://code.claude.com/docs/en/memory.md#auto-memory), loaded skills, and system instructions. As you work, context fills up. Claude compacts automatically, but instructions from early in the conversation can get lost. Put persistent rules in CLAUDE.md, and run `/context` to see what's using space.

For an interactive walkthrough of what loads and when, see [Explore the context window](https://code.claude.com/docs/en/context-window.md).

#### Context Claude Code adds on its own

If Claude follows a rule you didn't write, such as adding a `Co-Authored-By` trailer to a commit, the rule may have come from a [system reminder](https://code.claude.com/docs/en/glossary.md#system-reminder). As you work, Claude Code adds its own context to the conversation alongside your messages:

* Your CLAUDE.md files
* The instructions of your [output style](https://code.claude.com/docs/en/output-styles.md)
* A note when a file Claude read earlier changes on disk
* The commit and pull request attribution lines

To change or remove the attribution lines, set [`attribution`](https://code.claude.com/docs/en/settings-reference#attribution). To remove Claude Code's built-in commit and pull request instructions, set [`includeGitInstructions`](https://code.claude.com/docs/en/settings-reference#includegitinstructions) to `false`. For the other switches, see [Turn off the context your agent replaces](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts.md#turn-off-the-context-your-agent-replaces).

#### When context fills up

Claude Code manages context automatically as you approach the limit. It clears older tool outputs first, then summarizes the conversation if needed. Your requests and key code snippets are preserved; detailed instructions from early in the conversation may be lost. Put persistent rules in CLAUDE.md rather than relying on conversation history.

To control what's preserved during compaction, add a "Compact Instructions" section to CLAUDE.md or run `/compact` with a focus (like `/compact focus on the API changes`).

If a single file or tool output is so large that context refills immediately after each summary, Claude Code stops auto-compacting after a few attempts and shows an error instead of looping. See [Auto-compaction stops with a thrashing error](https://code.claude.com/docs/en/troubleshooting.md#auto-compaction-stops-with-a-thrashing-error) for recovery steps.

Run `/context` to see what's using space. MCP tool definitions are deferred by default and loaded on demand via [tool search](https://code.claude.com/docs/en/mcp.md#scale-with-mcp-tool-search), so only tool names and server instructions consume context until Claude uses a specific tool.

#### Manage context with skills and subagents

Beyond compaction, you can use other features to control what loads into context.

[Skills](https://code.claude.com/docs/en/skills.md) load on demand. Claude sees skill descriptions at session start, but the full content only loads when a skill is used. For skills you invoke manually, set `disable-model-invocation: true` to keep descriptions out of context until you need them. For skills you didn't write, use [`skillOverrides`](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings) to do the same from settings.

[Subagents](https://code.claude.com/docs/en/sub-agents.md) work in their own context window. A subagent starts fresh unless it's a [fork](https://code.claude.com/docs/en/sub-agents.md#fork-the-current-conversation), which starts with a copy of your conversation so far. Either way, the subagent's tool calls stay out of your context, and Claude gets back a summary when the subagent finishes.

See [context costs](https://code.claude.com/docs/en/features-overview.md#understand-context-costs) for what each feature costs, and [reduce token usage](https://code.claude.com/docs/en/costs.md#reduce-token-usage) for tips on managing context.

## Stay safe with checkpoints and permissions

Claude has two safety mechanisms: checkpoints let you undo file changes, and permissions control what Claude can do without asking.

### Undo changes with checkpoints

**File edits are reversible.** Before Claude edits a file, it snapshots the current contents. If something goes wrong, press `Esc` twice to rewind to a previous state, or ask Claude to undo.

Checkpoints are separate from git and remain available when you resume a conversation. They only cover file changes, and a restore [skips symlinked and hard-linked files](https://code.claude.com/docs/en/checkpointing.md#symlinked-and-hard-linked-paths-not-restored). Actions that affect remote systems (databases, APIs, deployments) can't be checkpointed. You control those with your permission mode and permission rules.

### Control what Claude can do

Choose a permission mode to set what Claude can do without asking you. Press `Shift+Tab` to cycle through the permission modes:

* **Auto**: a classifier reviews most actions in the background and blocks the risky ones instead of asking you. With Claude Code v2.1.283 or later, it's the [built-in starting permission mode](https://code.claude.com/docs/en/permission-modes.md#which-mode-a-session-starts-in) for interactive terminal and VS Code sessions, and on earlier versions only on Pro, Max, and Team plans
* **Manual**: Claude asks before file edits and shell commands
* **Accept edits**: Claude edits files and runs common filesystem commands like `mkdir` and `mv` without asking, still asks for other commands
* **Plan**: Claude explores and proposes a plan without editing your source files

You can also allow specific commands in `.claude/settings.json` so Claude doesn't ask each time. This is useful for trusted commands like `npm test` or `git status`. Settings can be scoped from organization-wide policies down to personal preferences. See [Permissions](https://code.claude.com/docs/en/permissions.md) for details.

***

## Work effectively with Claude Code

These tips help you get better results from Claude Code. For more on specific prompts, verification, and planning, see [Best practices](https://code.claude.com/docs/en/best-practices.md).

### Ask Claude Code for help

Claude Code can teach you how to use it. Ask questions like "how do I set up hooks?" or "what's the best way to structure my CLAUDE.md?" and Claude will explain.

Built-in commands also guide you through setup:

* `/init` generates a starter CLAUDE.md for your project
* `/doctor` runs a setup checkup that diagnoses installation and configuration issues and can fix them

### It's a conversation

Claude Code is conversational. You don't need perfect prompts. Start with what you want, then refine:

```text theme={null}
Fix the login bug
```

\[Claude investigates, tries something]

```text theme={null}
That's not quite right. The issue is in the session handling.
```

\[Claude adjusts approach]

When the first attempt isn't right, you don't start over. You iterate.

#### Interrupt and steer

You can redirect Claude at any point without starting over. Do either of these:

* **Press `Esc`** to stop Claude immediately. The running tool call is canceled and Claude waits for your next instruction. If you have messages queued, Claude Code [sends them next](https://code.claude.com/docs/en/interactive-mode.md#queue-messages-while-claude-works).
* **Type a correction and press `Enter`** without stopping Claude. The message shows as queued in the conversation. If Claude is running tool calls, it reads the message as soon as those calls finish, within the same turn, and adjusts before its next step. [Queue messages while Claude works](https://code.claude.com/docs/en/interactive-mode.md#queue-messages-while-claude-works) covers when other queued entries are sent.

### Delegate, don't dictate

Think of delegating to a capable colleague. Give context and direction, then trust Claude to figure out the details:

```text theme={null}
The checkout flow is broken for users with expired cards.
The relevant code is in src/payments/. Can you investigate and fix it?
```

You don't need to specify which files to read or what commands to run. Claude figures that out.

## What's next

> **[Extend with features](https://code.claude.com/docs/en/features-overview.md)**
>
> Add skills and MCP connections

> **[Common workflows](https://code.claude.com/docs/en/common-workflows.md)**
>
> Step-by-step guides for typical tasks
