> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Agent SDK overview

> Build production AI agents with Claude Code as a library

An agent is an application that completes a task by planning its own steps and calling tools that read files, run commands, or edit code. The Agent SDK gives you the same tools, [agent loop](/docs/en/agent-sdk/agent-loop), and context management that power Claude Code, programmable in Python and TypeScript.

## Compare the Agent SDK to other Claude tools

The Agent SDK, the CLI, the Client SDK, and Managed Agents differ in who runs the agent, what comes built in, and how you reach it. Find the row that matches how you want to build and run yours.

| You want to                                                                                      | Use                                                                               | What you get                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embed Claude Code's agent in your own Python or TypeScript application, in a process you operate | **Agent SDK**                                                                     | A library that runs the Claude Code binary, with Claude Code's [capabilities](#capabilities), such as built-in tools, permissions, sessions, and hooks.                                                                                                                                                                                                                                       |
| Do interactive development or run one-off tasks from a terminal                                  | [**Claude Code CLI**](/docs/en/overview)                                               | The terminal interface, built for daily interactive use.                                                                                                                                                                                                                                                                                                                                      |
| Call the Claude API directly from your own code                                                  | [**Client SDK**](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) | Direct access to the Claude API from any of the client SDK languages. You write the tool loop yourself, or let the client SDK's beta [tool runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner) drive it.                                                                                                                                                       |
| Have Anthropic host the agent, configured through the Claude API                                 | [**Managed Agents**](https://platform.claude.com/docs/en/managed-agents/overview) | A hosted agent harness that runs the agent loop, with sessions in an Anthropic-managed cloud sandbox or a [self-hosted sandbox](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes) on your own infrastructure. Use it from the [SDK for your language](https://platform.claude.com/docs/en/managed-agents/quickstart#install-the-sdk), the `ant` CLI, or the REST API. |

To drive the same agent loop from a language other than Python or TypeScript, [run the CLI as a subprocess](/docs/en/headless) with the `-p` flag and `--output-format json`.

## Capabilities

These Claude Code capabilities are available in the SDK:

| Capability                   | What it does                                                                                 | Learn more                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in tools               | Read, write, edit files, run commands, and search the web                                    | [Tools reference](/docs/en/tools-reference)                                                                                                                                                                         |
| Hooks                        | Run custom code at key points in the agent lifecycle                                         | [Hooks](/docs/en/agent-sdk/hooks)                                                                                                                                                                                   |
| Subagents                    | Spawn specialized agents for focused subtasks                                                | [Subagents](/docs/en/agent-sdk/subagents)                                                                                                                                                                           |
| MCP                          | Connect external tools and data sources via the Model Context Protocol                       | [MCP](/docs/en/agent-sdk/mcp)                                                                                                                                                                                       |
| Permissions                  | Control which tools run automatically, which need approval                                   | [Permissions](/docs/en/agent-sdk/permissions)                                                                                                                                                                       |
| Sessions                     | Maintain context across exchanges, resume or fork later                                      | [Sessions](/docs/en/agent-sdk/sessions)                                                                                                                                                                             |
| Skills, commands, and memory | Load automatically from your project's `.claude/` and from `~/.claude/`, same as Claude Code | [Skills](/docs/en/agent-sdk/skills), [Commands](/docs/en/agent-sdk/skills#commands-in-agent-sdk-sessions), [Memory](/docs/en/agent-sdk/modifying-system-prompts), [Configuration loading](/docs/en/agent-sdk/claude-code-features) |
| Plugins                      | Package skills, agents, hooks, and MCP servers, and load them by local path                  | [Plugins](/docs/en/agent-sdk/plugins)                                                                                                                                                                               |

## Get started

Follow the [Quickstart](/docs/en/agent-sdk/quickstart) to install the SDK, set your API key, and build your first agent, one that finds and fixes bugs in existing code.

<Note>
  Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the [Quickstart](/docs/en/agent-sdk/quickstart) instead.
</Note>

## Changelog

View the full changelog for SDK updates, bug fixes, and new features:

* **TypeScript SDK**: [view CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
* **Python SDK**: [view CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-python/blob/main/CHANGELOG.md)

## Report bugs

If you encounter bugs or issues with the Agent SDK:

* **TypeScript SDK**: [report issues on GitHub](https://github.com/anthropics/claude-agent-sdk-typescript/issues)
* **Python SDK**: [report issues on GitHub](https://github.com/anthropics/claude-agent-sdk-python/issues)

## Branding guidelines

For partners integrating the Claude Agent SDK, use of Claude branding is optional. When referencing Claude in your product:

**Allowed:**

* "Claude Agent", preferred for dropdown menus
* "Claude", when within a menu already labeled "Agents"
* "\{YourAgentName} Powered by Claude", if you have an existing agent name

**Not permitted:**

* "Claude Code" or "Claude Code Agent"
* Claude Code-branded ASCII art or visual elements that mimic Claude Code

Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product. For questions about branding compliance, contact the Anthropic [sales team](https://www.anthropic.com/contact-sales).

## License and terms

Use of the Claude Agent SDK is governed by [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), including when you use it to power products and services that you make available to your own customers and end users, except to the extent a specific component or dependency is covered by a different license as indicated in that component's LICENSE file.

## Next steps

These resources cover deeper technical detail and example projects for building with the Agent SDK.

* [Quickstart](/docs/en/agent-sdk/quickstart): build your first agent that finds and fixes bugs
* [Migration guide](/docs/en/agent-sdk/migration-guide): migrate from the Claude Code SDK packages to the Agent SDK
* [Agent loop](/docs/en/agent-sdk/agent-loop): how Claude plans, calls tools, and decides when a task is done
* [Example agents](https://github.com/anthropics/claude-agent-sdk-demos): demo apps for local development
* [TypeScript SDK](/docs/en/agent-sdk/typescript): full TypeScript API reference and examples
* [Python SDK](/docs/en/agent-sdk/python): full Python API reference and examples
* [Agent harness design](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code): how the Claude Code team uses dynamic workflows to orchestrate many subagents at once
