# Claude Code Docs

> Official documentation for Claude Code, Anthropic's agentic coding tool available in the terminal, IDE, desktop app, and browser. Covers installation, configuration, skills, subagents, hooks, MCP, the Agent SDK, and reference material.

## Getting started

### Getting started

- [Overview](https://code.claude.com/docs/en/overview.md): Claude Code is an agentic coding tool that reads your codebase, edits files, runs commands, and integrates with your development tools. Available in your terminal, IDE, desktop app, and browser.
- [Quickstart](https://code.claude.com/docs/en/quickstart.md): Welcome to Claude Code!
- [Claude Code changelog](https://code.claude.com/docs/en/changelog.md): Release notes for Claude Code, including new features, improvements, and bug fixes by version.

### Core concepts

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works.md): Understand the agentic loop, built-in tools, and how Claude Code interacts with your project.
- [Extend Claude Code](https://code.claude.com/docs/en/features-overview.md): Understand when to use CLAUDE.md, Skills, subagents, hooks, MCP, and plugins.
- [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory.md): Where Claude Code reads CLAUDE.md, settings.json, hooks, skills, commands, subagents, workflows, rules, and auto memory. Explore the .claude directory in your project and ~/.claude in your home directory.
- [Explore the context window](https://code.claude.com/docs/en/context-window.md): An interactive simulation of how Claude Code's context window fills during a session. See what loads automatically, what each file read costs, and when rules and hooks fire.
- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching.md): Claude Code manages prompt caching automatically. See why a model switch triggers a slow uncached turn, what `/compact` costs, why CLAUDE.md edits don't apply mid-session, and how to check your cache hit rate.

### Use Claude Code

- [How Claude remembers your project](https://code.claude.com/docs/en/memory.md): Give Claude persistent instructions with CLAUDE.md files, and let Claude accumulate learnings automatically with auto memory.
- [Manage sessions](https://code.claude.com/docs/en/sessions.md): Name, resume, branch, and switch between Claude Code conversations. Covers `--continue`, `--resume`, `--from-pr`, the `/resume` picker, session naming, exporting transcripts, and where transcripts are stored.
- [Common workflows](https://code.claude.com/docs/en/common-workflows.md): Step-by-step guides for exploring codebases, fixing bugs, refactoring, testing, and other everyday tasks with Claude Code.
- [Prompt library](https://code.claude.com/docs/en/prompt-library.md): Copy-paste prompts for Claude Code, tagged by task and role.
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices.md): Tips and patterns for getting the most out of Claude Code, from configuring your environment to scaling across parallel sessions.

### Platforms and integrations

- [Platforms and integrations](https://code.claude.com/docs/en/platforms.md): Choose where to run Claude Code and what to connect it to. Compare the CLI, Desktop, VS Code, JetBrains, web, mobile, and integrations like Chrome, Slack, and CI/CD.
- [Continue local sessions from any device with Remote Control](https://code.claude.com/docs/en/remote-control.md): Continue a local Claude Code session from your phone, tablet, or any browser using Remote Control. Works with claude.ai/code and the Claude mobile app.
- [Claude Code on mobile](https://code.claude.com/docs/en/mobile.md): Start, monitor, and steer Claude Code tasks from your phone with the Claude app for iOS and Android.
- [Use Claude Code with Chrome](https://code.claude.com/docs/en/chrome.md): Connect Claude Code to your Chrome browser to test web apps, debug with console logs, automate form filling, and extract data from web pages.
- [Let Claude use your computer from the CLI](https://code.claude.com/docs/en/computer-use.md): Enable computer use in the Claude Code CLI so Claude can open apps, click, type, and see your screen on macOS. Test native apps, debug visual issues, and automate GUI-only tools without leaving your terminal.
- [Use Claude Code in VS Code](https://code.claude.com/docs/en/vs-code.md): Install and configure the Claude Code extension for VS Code. Get AI coding assistance with inline diffs, @-mentions, plan review, and keyboard shortcuts.
- [JetBrains IDEs](https://code.claude.com/docs/en/jetbrains.md): Use Claude Code with JetBrains IDEs including IntelliJ, PyCharm, WebStorm, and more
- [Claude Code in Slack](https://code.claude.com/docs/en/slack.md): Delegate coding tasks directly from your Slack workspace. Anthropic is retiring this earlier version for Team and Enterprise workspaces in favor of Claude Tag; it remains the setup path on Pro and Max plans.
- [Claude Tag](https://code.claude.com/docs/en/claude-tag.md): Bring Claude into your team's Slack channels with Claude Tag and find its setup and usage documentation on claude.com.

#### Claude Code on the web

- [Get started with Claude Code on the web](https://code.claude.com/docs/en/web-quickstart.md): Run Claude Code in the cloud from your browser or phone. Connect a GitHub repository, submit a task, and review the PR without local setup.
- [Use Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web.md): Move sessions between web and terminal with `--cloud` and `--teleport`, manage and share sessions, and auto-fix pull requests from the cloud.
- [Automate work with routines](https://code.claude.com/docs/en/routines.md): Put Claude Code on autopilot. Define routines that run on a schedule, trigger on API calls, or react to GitHub events from cloud infrastructure.
- [Find bugs with ultrareview](https://code.claude.com/docs/en/ultrareview.md): Run a deep, multi-agent code review in the cloud with /code-review ultra to find and verify bugs before you merge.

#### Claude Code on desktop

- [Get started with the desktop app](https://code.claude.com/docs/en/desktop-quickstart.md): Install Claude Code on desktop and start your first coding session
- [Desktop application](https://code.claude.com/docs/en/desktop.md): Get more out of Claude Code Desktop: parallel sessions with Git isolation, drag-and-drop pane layout, integrated terminal and file editor, side chats, computer use, Dispatch sessions from your phone, visual diff review, app previews, PR monitoring, connectors, and enterprise configuration.
- [Claude Desktop on Linux (beta)](https://code.claude.com/docs/en/desktop-linux.md): Install and update the Claude desktop app on Ubuntu and Debian
- [Claude Code Desktop in WSL](https://code.claude.com/docs/en/desktop-wsl.md): Run Code sessions inside a WSL 2 distribution on Windows
- [Schedule recurring tasks in Claude Code Desktop](https://code.claude.com/docs/en/desktop-scheduled-tasks.md): Set up scheduled tasks in Claude Code Desktop to run Claude automatically on a recurring basis for daily code reviews, dependency audits, or morning briefings.
- [Test iOS apps in the simulator](https://code.claude.com/docs/en/desktop-ios-simulator.md): Claude Code Desktop opens your app in the iOS Simulator pane when Claude builds, runs, or checks it, with a separate simulator for each session.

#### Code review & CI/CD

- [Catch security issues as Claude writes code](https://code.claude.com/docs/en/security-guidance.md): Install the security-guidance plugin to have Claude review its own code changes for vulnerabilities and fix them in the same session.
- [Scan your codebase for vulnerabilities](https://code.claude.com/docs/en/claude-security.md): Install the Claude Security plugin to scan your codebase for vulnerabilities in a Claude Code session and turn findings into patches you review and apply.
- [Code Review](https://code.claude.com/docs/en/code-review.md): Set up automated PR reviews that catch logic errors, security vulnerabilities, and regressions using multi-agent analysis of your full codebase
- [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions.md): Run Claude Code in GitHub Actions workflows to respond to @claude mentions, automate tasks, and turn issues into pull requests
- [Use Claude Code GitHub Actions with cloud providers](https://code.claude.com/docs/en/github-actions-cloud-providers.md): Run Claude Code GitHub Actions through Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry instead of the Claude API
- [Claude Code with GitHub Enterprise Server](https://code.claude.com/docs/en/github-enterprise-server.md): Connect Claude Code to your self-hosted GitHub Enterprise Server instance for web sessions, code review, and plugin marketplaces.
- [Claude Code GitLab CI/CD](https://code.claude.com/docs/en/gitlab-ci-cd.md): Learn about integrating Claude Code into your development workflow with GitLab CI/CD

## Build with Claude Code

### Agents and parallel work

- [Run agents in parallel](https://code.claude.com/docs/en/agents.md): Compare the ways Claude Code can take on multiple tasks at once: subagents, agent view, agent teams, and dynamic workflows.
- [Create custom subagents](https://code.claude.com/docs/en/sub-agents.md): Create and use specialized AI subagents in Claude Code for task-specific workflows and improved context management.
- [Manage multiple agents with agent view](https://code.claude.com/docs/en/agent-view.md): Dispatch and manage many Claude Code sessions from one screen. Agent view shows what every session is doing and which ones need your input.
- [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams.md): Coordinate multiple Claude Code instances working together as a team, with shared tasks, inter-agent messaging, and centralized management.
- [Message your other Claude Code sessions](https://code.claude.com/docs/en/cross-session-messaging.md): Let Claude list and message your other Claude Code sessions on this machine, and reach your sessions on other machines or on the web.
- [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows.md): Dynamic workflows orchestrate many subagents from a script Claude writes and you can rerun. Use them for codebase audits, large migrations, and cross-checked research.
- [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees.md): Isolate parallel Claude Code sessions in separate git worktrees so changes don't collide. Covers the `--worktree` flag, subagent isolation, `.worktreeinclude`, cleanup, and non-git VCS hooks.

### MCP

- [Connect to MCP servers](https://code.claude.com/docs/en/mcp-quickstart.md): Add an MCP server to Claude Code, verify the connection, and find the configuration on disk.
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp.md): Learn how to connect Claude Code to your tools with the Model Context Protocol.

### Skills

- [Extend Claude with skills](https://code.claude.com/docs/en/skills.md): Create, manage, and share skills to extend Claude's capabilities in Claude Code. Includes custom commands and bundled skills.

### Plugins

- [Discover and install prebuilt plugins through marketplaces](https://code.claude.com/docs/en/discover-plugins.md): Find and install plugins from marketplaces to extend Claude Code with new skills, agents, and capabilities.
- [Create plugins](https://code.claude.com/docs/en/plugins.md): Create custom plugins to extend Claude Code with skills, agents, hooks, and MCP servers.

### Artifacts

- [Share session output as artifacts](https://code.claude.com/docs/en/artifacts.md): Artifacts turn Claude Code's work into live, interactive pages on claude.ai that you can keep private, share with your organization, or publish to a public link.

### Automation

- [Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide.md): Run shell commands automatically when Claude Code edits files, finishes tasks, or needs input. Format code, send notifications, validate commands, and enforce project rules.
- [Push events into a running session with channels](https://code.claude.com/docs/en/channels.md): Use channels to push messages, alerts, and webhooks into your Claude Code session from an MCP server. Forward CI results, chat messages, and monitoring events so Claude can react while you're away.
- [Run prompts on a schedule](https://code.claude.com/docs/en/scheduled-tasks.md): Use /loop and the cron scheduling tools to run prompts repeatedly, poll for status, or set one-time reminders within a Claude Code session.
- [Keep Claude working toward a goal](https://code.claude.com/docs/en/goal.md): Set a completion condition with /goal and Claude keeps working until it's met, a model judges it impossible, or an error you have to fix clears the goal.
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless.md): Use the Agent SDK to run Claude Code programmatically from the CLI, Python, or TypeScript.
- [Launch sessions from links](https://code.claude.com/docs/en/deep-links.md): Open a Claude Code terminal session from a URL. Embed `claude-cli://` links in runbooks, alerts, and dashboards so a click opens Claude Code in the right repo with the right prompt.

### Guides

- [Set up Claude Code in a monorepo or large codebase](https://code.claude.com/docs/en/large-codebases.md): Configure Claude Code for monorepos and large single-tree codebases with nested CLAUDE.md files, sparse worktrees, code intelligence, and per-package skills so Claude stays focused on the code you're working in.

### Troubleshooting

- [Troubleshoot installation and login](https://code.claude.com/docs/en/troubleshoot-install.md): Fix command not found, PATH, permission, network, and authentication errors when installing or signing in to Claude Code.
- [Troubleshooting](https://code.claude.com/docs/en/troubleshooting.md): Fix high CPU or memory usage, hangs, auto-compact thrashing, and search problems in Claude Code, and find the right page for other issues.
- [Debug your configuration](https://code.claude.com/docs/en/debug-your-config.md): Diagnose why CLAUDE.md, settings, hooks, MCP servers, or skills aren't taking effect. Use /context, /doctor, /hooks, and /mcp to see what actually loaded.
- [Error reference](https://code.claude.com/docs/en/errors.md): Look up Claude Code runtime error messages with what each one means and how to fix it.

## Administration

### Setup and access

- [Set up Claude Code for your organization](https://code.claude.com/docs/en/admin-setup.md): A decision map for administrators deploying Claude Code, covering API providers, managed settings, policy enforcement, usage monitoring, and data handling.
- [Advanced setup](https://code.claude.com/docs/en/setup.md): System requirements, platform-specific installation, version management, and uninstallation for Claude Code.
- [Authentication](https://code.claude.com/docs/en/authentication.md): Log in to Claude Code and configure authentication for individuals, teams, and organizations.
- [Deploy managed settings](https://code.claude.com/docs/en/managed-settings.md): Deploy managed settings to every developer's machine: delivery mechanisms per OS, how Claude Code combines managed sources, and how to verify enforcement.
- [Configure server-managed settings](https://code.claude.com/docs/en/server-managed-settings.md): Centrally configure Claude Code for your organization through server-delivered settings, without requiring device management infrastructure.
- [Control MCP server access for your organization](https://code.claude.com/docs/en/managed-mcp.md): Restrict which MCP servers users can add or connect to with managed configuration files, allowlists, and denylists.
- [Configure auto mode](https://code.claude.com/docs/en/auto-mode-config.md): Tell the auto mode classifier which repos, buckets, and domains your organization trusts. Set environment context, override the default block and allow rules, and inspect your effective config with the auto-mode CLI subcommands.

### Deployment

- [Enterprise deployment overview](https://code.claude.com/docs/en/third-party-integrations.md): Learn how Claude Code can integrate with various third-party services and infrastructure to meet enterprise deployment requirements.
- [Feature availability](https://code.claude.com/docs/en/feature-availability.md): Compare which Claude Code features are available across Anthropic subscription plans, the Anthropic Console, Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, and Microsoft Foundry.
- [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock.md): Learn about configuring Claude Code through Amazon Bedrock, including setup, IAM configuration, and troubleshooting.
- [Claude Code on Claude Platform on AWS](https://code.claude.com/docs/en/claude-platform-on-aws.md): Configure Claude Code to use the Anthropic-operated Claude API with AWS authentication, IAM access control, and AWS Marketplace billing.
- [Claude Code on Google Cloud's Agent Platform](https://code.claude.com/docs/en/google-vertex-ai.md): Learn about configuring Claude Code through Google Cloud's Agent Platform, formerly Vertex AI, including setup, IAM configuration, and troubleshooting.
- [Claude Code on Microsoft Foundry](https://code.claude.com/docs/en/microsoft-foundry.md): Learn about configuring Claude Code through Microsoft Foundry, including setup, configuration, and troubleshooting.
- [Enterprise network configuration](https://code.claude.com/docs/en/network-config.md): Configure Claude Code for enterprise environments with proxy servers, custom Certificate Authorities (CA), and mutual Transport Layer Security (mTLS) authentication.
- [Run Claude Code behind a corporate launcher](https://code.claude.com/docs/en/corporate-launcher.md): Route the processes Claude Code starts from its own binary, including the background service and every agent view session, through a required launcher with CLAUDE_CODE_PROCESS_WRAPPER or the processWrapper setting.
- [Development containers](https://code.claude.com/docs/en/devcontainer.md): Run Claude Code inside a dev container for consistent, isolated environments across your team.

### Gateways

- [Run Claude Code through a gateway](https://code.claude.com/docs/en/gateways.md): Route Claude Code through a self-hosted gateway for centralized credentials, usage tracking, and cost controls. Covers the architecture, Anthropic's Claude apps gateway, and using other gateway products.

#### Claude apps gateway

- [Claude apps gateway for Amazon Bedrock, Claude Platform on AWS, Google Cloud, and Microsoft Foundry](https://code.claude.com/docs/en/claude-apps-gateway.md): Run Claude Code through Amazon Bedrock, Claude Platform on AWS, Google Cloud, or Microsoft Foundry behind a self-hosted gateway with SSO sign-in, per-group model access, and OTLP telemetry.
- [Claude apps gateway configuration](https://code.claude.com/docs/en/claude-apps-gateway-config.md): Reference for every gateway.yaml option: listener and TLS, OIDC, session, Postgres store, Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, and Microsoft Foundry upstreams, model routing, managed policies, and telemetry.
- [Claude apps gateway spend limits](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits.md): Cap each developer's spend through the Claude apps gateway by day, week, or month. Set limits with an Admin API and the gateway enforces them live on every request.
- [Claude apps gateway deployment and operations](https://code.claude.com/docs/en/claude-apps-gateway-deploy.md): Register the gateway with your IdP, build the container, deploy on Kubernetes or Cloud Run, and operate it: health checks, secret rotation, upgrades, and security.
- [Deploy Claude apps gateway on AWS](https://code.claude.com/docs/en/claude-apps-gateway-on-aws.md): A worked example of running Claude apps gateway on AWS: ECS Fargate or EKS, Amazon RDS for PostgreSQL, AWS Secrets Manager, and IAM-role auth to Amazon Bedrock.
- [Deploy Claude apps gateway on Google Cloud](https://code.claude.com/docs/en/claude-apps-gateway-on-gcp.md): A worked example of running Claude apps gateway on Google Cloud: Cloud Run or GKE, Cloud SQL for PostgreSQL, Secret Manager, and service-account auth to Google Cloud's Agent Platform.

#### Other gateways

- [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway.md): Route Claude Code through an LLM gateway your organization already runs. Covers connecting Claude Code to a gateway, rolling one out for your organization, and what Claude Code sends to a gateway.
- [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect.md): Point Claude Code at your organization's LLM gateway. Check whether your admin already configured it, or set the base URL and credential yourself, then verify the connection and fix gateway errors.
- [Roll out an LLM gateway for your organization](https://code.claude.com/docs/en/llm-gateway-rollout.md): Deploy a gateway product for Claude Code: configure it to forward what Claude Code sends, issue developer credentials, distribute the configuration through managed settings, and verify the rollout.
- [Gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol.md): The API contract between Claude Code and an LLM gateway: endpoints, headers and body fields to forward, feature degradation when fields are stripped, attribution headers for cost tracking, and model discovery.

### Usage and costs

- [Monitoring](https://code.claude.com/docs/en/monitoring-usage.md): Learn how to enable and configure OpenTelemetry for Claude Code.
- [Manage costs effectively](https://code.claude.com/docs/en/costs.md): Track token usage, set team spend limits, and reduce Claude Code costs with context management, model selection, extended thinking settings, and preprocessing hooks.
- [Track team usage with analytics](https://code.claude.com/docs/en/analytics.md): View Claude Code usage metrics, track adoption, and measure engineering velocity in the analytics dashboard.

### Plugin distribution

- [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces.md): Build and host plugin marketplaces to distribute Claude Code extensions across teams and communities.
- [Constrain plugin dependency versions](https://code.claude.com/docs/en/plugin-dependencies.md): Declare version constraints on plugin dependencies, and bundle a curated plugin set behind one install.
- [Recommend your plugin from your CLI](https://code.claude.com/docs/en/plugin-hints.md): Emit a one-line marker from your CLI so Claude Code prompts users to install your official plugin.
- [Recommend plugins for your org](https://code.claude.com/docs/en/plugin-relevance.md): Add a relevance block to marketplace plugin entries so Claude Code suggests them when a user's work matches.

### Security and data

- [Security](https://code.claude.com/docs/en/security.md): Learn about Claude Code's security safeguards and best practices for safe usage.
- [Data usage](https://code.claude.com/docs/en/data-usage.md): Learn about Anthropic's data usage policies for Claude
- [Zero data retention](https://code.claude.com/docs/en/zero-data-retention.md): Learn about Zero Data Retention (ZDR) for Claude Code, available to qualified accounts on Claude for Enterprise, including scope, disabled features, and how to request enablement.

### Adoption

- [Communications kit](https://code.claude.com/docs/en/communications-kit.md): Launch announcements, drip-campaign messages, and FAQ responses for rolling Claude Code out to your engineering organization.
- [Champion kit](https://code.claude.com/docs/en/champion-kit.md): A playbook for engineers advocating Claude Code internally: what to share, how to answer questions, and how to grow adoption on your team.

## Configuration

### Settings

- [Claude Code settings](https://code.claude.com/docs/en/settings.md): Change Claude Code settings, pick the scope a key belongs in, verify the change, and learn which value Claude Code uses when a key is set in several places.
- [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference.md): Complete reference for every Claude Code settings.json key: where each one goes, its type and default, and a paste-ready example, with an index of every key.
- [Example settings files](https://code.claude.com/docs/en/settings-example.md): Realistic settings.json files for a developer, a team, and an organization: copy one, keep the keys you want, and change the values.

### Permissions and sandboxing

- [Configure permissions](https://code.claude.com/docs/en/permissions.md): Control what Claude Code can access and do with fine-grained permission rules, modes, and managed policies.
- [Choose a permission mode](https://code.claude.com/docs/en/permission-modes.md): Control whether Claude asks before acting. Switch permission modes with Shift+Tab in the CLI, the mode indicator in VS Code, or the mode selector in Desktop.
- [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing.md): Learn how Claude Code's sandboxed Bash tool provides filesystem and network isolation for safer, more autonomous agent execution.
- [Choose a sandbox environment](https://code.claude.com/docs/en/sandbox-environments.md): Compare Claude Code sandbox options: the built-in sandboxed Bash tool, sandbox runtime, dev containers, Docker, and VMs. Choose the right isolation for your threat model.

### Environments

- [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments.md): Configure cloud environments for Claude Code cloud sessions: network access levels, environment variables, setup scripts, and environment caching.

#### Self-hosted environments

- [Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments.md): Run Claude Code cloud sessions on infrastructure you control: set up a self-hosted environment, deploy runners, and route sessions to your own compute.
- [Self-hosted environments quickstart](https://code.claude.com/docs/en/self-hosted-environments-quickstart.md): Set up your first self-hosted environment: install Claude Code, create the environment, start a runner, and route a session to it.
- [Deploy self-hosted environments to production](https://code.claude.com/docs/en/self-hosted-environments-deploy.md): Run self-hosted runners in production: security hardening, network egress control, git credentials, Kubernetes and Compose recipes, and troubleshooting.
- [Customize sessions in self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments-configuration.md): Customize self-hosted environment sessions with wrapper scripts for per-session credentials, lifecycle hooks, and on-demand runner spawning.
- [Test self-hosted environments end to end](https://code.claude.com/docs/en/self-hosted-environments-testing.md): Verify a self-hosted runner image from CI: dispatch a session with the CLI, read Claude's replies through a Stop hook, and script the full loop.
- [Self-hosted environments reference](https://code.claude.com/docs/en/self-hosted-environments-reference.md): Complete reference for the self-hosted runner and orchestrator: CLI flags, environment variables, and Prometheus metrics.
- [Verify session identity in self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments-identity.md): Verify the CLAUDE_CODE_SESSION_ACCESS_TOKEN JWT so services on your network can trust requests from sessions in your self-hosted environment.

### Model and responses

- [Model configuration](https://code.claude.com/docs/en/model-config.md): Configure which model Claude Code uses, effort levels, extended context, and the auto-compact window
- [Speed up responses with fast mode](https://code.claude.com/docs/en/fast-mode.md): Get faster Opus responses in Claude Code by toggling fast mode.
- [Escalate hard decisions with the advisor tool](https://code.claude.com/docs/en/advisor.md): Pair your main model with a stronger advisor model that Claude consults at key moments during a task.
- [Output styles](https://code.claude.com/docs/en/output-styles.md): Adapt Claude Code for uses beyond software engineering

### Interface

- [Configure your terminal for Claude Code](https://code.claude.com/docs/en/terminal-config.md): Fix Shift+Enter for newlines, get a terminal bell when Claude finishes, configure tmux, match the color theme, and enable Vim mode in the Claude Code CLI.
- [Fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md): Enable a smoother, flicker-free rendering mode with mouse support and stable memory usage in long conversations.
- [Use Claude Code with a screen reader](https://code.claude.com/docs/en/accessibility.md): Set up Claude Code for screen readers such as VoiceOver and NVDA, plus settings for screen magnifiers, reduced motion, and colorblind-friendly themes.
- [Voice dictation](https://code.claude.com/docs/en/voice-dictation.md): Speak your prompts in the Claude Code CLI with hold-to-record or tap-to-record voice dictation.
- [Customize your status line](https://code.claude.com/docs/en/statusline.md): Configure a custom status bar to monitor context window usage, costs, and git status in Claude Code
- [Customize keyboard shortcuts](https://code.claude.com/docs/en/keybindings.md): Customize keyboard shortcuts in Claude Code with a keybindings configuration file.

## Reference

### Reference

- [CLI reference](https://code.claude.com/docs/en/cli-reference.md): Complete reference for Claude Code command-line interface, including commands and flags.
- [Commands](https://code.claude.com/docs/en/commands.md): Complete reference for commands available in Claude Code, including built-in commands and bundled skills.
- [Environment variables](https://code.claude.com/docs/en/env-vars.md): Reference for environment variables that control Claude Code behavior.
- [Tools reference](https://code.claude.com/docs/en/tools-reference.md): Complete reference for the tools Claude Code can use, including permission requirements and per-tool behavior.
- [Interactive mode](https://code.claude.com/docs/en/interactive-mode.md): Complete reference for keyboard shortcuts, input modes, and interactive features in Claude Code sessions.
- [Checkpointing](https://code.claude.com/docs/en/checkpointing.md): Track, rewind, and summarize Claude's edits and conversation to manage session state.
- [Hooks reference](https://code.claude.com/docs/en/hooks.md): Reference for Claude Code hook events, configuration schema, JSON input/output formats, exit codes, async hooks, HTTP hooks, prompt hooks, and MCP tool hooks.
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference.md): Complete technical reference for Claude Code plugin system, including schemas, CLI commands, and component specifications.
- [Channels reference](https://code.claude.com/docs/en/channels-reference.md): Build an MCP server that pushes webhooks, alerts, and chat messages into a Claude Code session. Reference for the channel contract: capability declaration, notification events, reply tools, sender gating, and permission relay.

### Glossary

- [Glossary](https://code.claude.com/docs/en/glossary.md): Definitions for Claude Code terminology. Learn what agentic loop, compaction, CLAUDE.md, hooks, subagents, MCP, and other core concepts mean.

## Agent SDK

### Agent SDK

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md): Build production AI agents with Claude Code as a library
- [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md): Get started with the Python or TypeScript Agent SDK to build AI agents that work autonomously
- [Troubleshooting](https://code.claude.com/docs/en/agent-sdk/troubleshooting.md): Fix Agent SDK errors by the exact message you see, with the cause and fix for each error in the TypeScript and Python SDKs.

### Build agents

- [Examples](https://code.claude.com/docs/en/agent-sdk/examples.md): Find a complete, runnable Agent SDK project or a guided recipe in the Claude Cookbook that matches what you want to build.

### Core concepts

- [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop.md): Understand the message lifecycle, tool execution, context window, and architecture that power your SDK agents.
- [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md): Load project instructions, skills, hooks, and other Claude Code features into your SDK agents.
- [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md): How sessions persist agent conversation history, and when to use continue, resume, and fork to return to a prior run.
- [Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage.md): Mirror session transcripts to S3, Redis, or your own backend so other hosts can resume your sessions.

### Input and output

- [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md): Understanding the two input modes for Claude Agent SDK and when to use each
- [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input.md): Surface Claude's approval requests and clarifying questions to users, then return their decisions to the SDK.
- [Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output.md): Get real-time responses from the Agent SDK as text and tool calls stream in
- [Get structured output from agents](https://code.claude.com/docs/en/agent-sdk/structured-outputs.md): Return validated JSON from agent workflows using JSON Schema, Zod, or Pydantic. Get type-safe, structured data after multi-turn tool use.

### Extend with tools

- [Give Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools.md): Define custom tools with the Claude Agent SDK's in-process MCP server so Claude can call your functions, hit your APIs, and perform domain-specific operations.
- [Connect to external tools with MCP](https://code.claude.com/docs/en/agent-sdk/mcp.md): Configure MCP servers to extend your agent with external tools. Covers transport types, tool search for large tool sets, authentication, and error handling.
- [Scale to many tools with tool search](https://code.claude.com/docs/en/agent-sdk/tool-search.md): Scale your agent to thousands of tools by discovering and loading only what's needed, on demand.
- [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents.md): Define and invoke subagents to isolate context, run tasks in parallel, and apply specialized instructions in your Claude Agent SDK applications.

### Customize behavior

- [Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts.md): Choose between the `claude_code` preset and a custom system prompt, and customize behavior with CLAUDE.md, output styles, append, or a fully custom prompt.
- [Extend agents with skills](https://code.claude.com/docs/en/agent-sdk/skills.md): Control which skills Claude can invoke in Claude Agent SDK sessions, dispatch commands by name, and author skills your sessions discover
- [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins.md): Load custom plugins to extend Claude Code with skills, agents, hooks, and MCP servers through the Agent SDK

### Control and observability

- [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md): Control how your agent uses tools with permission modes, hooks, and declarative allow/deny rules.
- [Intercept and control agent behavior with hooks](https://code.claude.com/docs/en/agent-sdk/hooks.md): Intercept and customize agent behavior at key execution points with hooks
- [Rewind file changes with checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md): Track file changes during agent sessions and restore files to any previous state
- [Track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking.md): Learn how to track token usage, estimate costs, and configure prompt caching with the Claude Agent SDK.
- [Observability with OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability.md): Export traces, metrics, and events from the Agent SDK to your observability backend using OpenTelemetry.
- [Track todos](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md): Track todos in Agent SDK sessions and render Claude's progress in your application from structured tool calls

### Deployment

- [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting.md): Deploy the Agent SDK in production: subprocess architecture, session persistence, scaling, observability, and multi-tenant isolation for Docker, Kubernetes, and sandbox providers.
- [Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/secure-deployment.md): A guide to securing Claude Code and Agent SDK deployments with isolation, credential management, and network controls

### SDK references

- [Agent SDK reference - TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript.md): Complete API reference for the TypeScript Agent SDK, including all functions, types, and interfaces.
- [TypeScript SDK V2 session API (removed)](https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview.md): Reference for the removed V2 TypeScript Agent SDK session API, with session-based send/stream patterns for multi-turn conversations.
- [Agent SDK reference - Python](https://code.claude.com/docs/en/agent-sdk/python.md): Complete API reference for the Python Agent SDK, including all functions, types, and classes.
- [Migrate to Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/migration-guide.md): Guide for migrating the Claude Code TypeScript and Python SDKs to the Claude Agent SDK

## What's New

### What's New

- [What's new](https://code.claude.com/docs/en/whats-new/index.md): A weekly digest of notable Claude Code features, with code snippets, demos, and context on why they matter.
- [Week 34 · August 17–21, 2026](https://code.claude.com/docs/en/whats-new/2026-w34.md): Draft editable UI artboards with the /design skill, set the Concise output style, and start a Claude Code session on your machine from your phone.
- [Week 33 · August 10–14, 2026](https://code.claude.com/docs/en/whats-new/2026-w33.md): Claude Code Desktop auto-continues after a usage limit resets, fork mode turns on by default, and GitLab merge requests and marketplaces join GitHub.
- [Week 32 · August 3–7, 2026](https://code.claude.com/docs/en/whats-new/2026-w32.md): Claude Code sessions message each other, self-hosted environments run cloud sessions on your infrastructure, and auto mode becomes the default permission mode.
- [Week 30 · July 20–24, 2026](https://code.claude.com/docs/en/whats-new/2026-w30.md): Opus 5 becomes the default Opus model, Claude Code Desktop adds an iOS Simulator pane, and the Claude Security plugin scans your code for vulnerabilities.
- [Week 29 · July 13–17, 2026](https://code.claude.com/docs/en/whats-new/2026-w29.md): Pull live data into published artifacts through MCP connectors, and use Claude Code with a screen reader in the new screen reader mode.
- [Week 28 · July 6–10, 2026](https://code.claude.com/docs/en/whats-new/2026-w28.md): Browse external sites from the Desktop app's built-in browser, run a full setup checkup with /doctor, and pick up auto mode transcript protections and agent view upgrades.
- [Week 27 · June 29 – July 3, 2026](https://code.claude.com/docs/en/whats-new/2026-w27.md): Claude Sonnet 5 becomes the default model, Claude in Chrome reaches general availability, subagents run in the background by default, Claude Desktop arrives on Linux in beta, and /radio tunes into Claude FM.
- [Week 26 · June 22–26, 2026](https://code.claude.com/docs/en/whats-new/2026-w26.md): Authenticate MCP servers from your shell with claude mcp login, get a response to shell mode command output with the ! prefix, and resume a conversation from before /clear with /rewind.
- [Week 25 · June 15–19, 2026](https://code.claude.com/docs/en/whats-new/2026-w25.md): Publish a live, shareable page from your session with Artifacts, match tool parameters in deny and ask rules, and set any setting from the prompt with /config.
- [Week 24 · June 8–12, 2026](https://code.claude.com/docs/en/whats-new/2026-w24.md): Move a session to a new directory with /cd, let subagents spawn their own subagents, and troubleshoot a broken configuration with safe mode.
- [Week 23 · June 1–5, 2026](https://code.claude.com/docs/en/whats-new/2026-w23.md): Run auto mode on Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry, prompt before writing files that can run code in acceptEdits mode, list installed plugins with /plugin list, and require an approved version range for managed deployments.
- [Week 22 · May 25–29, 2026](https://code.claude.com/docs/en/whats-new/2026-w22.md): Run Claude Code on Claude Opus 4.8, orchestrate large tasks with dynamic workflows, catch security issues with the security-guidance plugin, and use fast mode on Opus 4.8 at a lower price.
- [Week 21 · May 18–22, 2026](https://code.claude.com/docs/en/whats-new/2026-w21.md): Use auto mode on the Pro plan and with Sonnet 4.6, see which skills, subagents, and MCP servers drive your plan limits in /usage, and review diffs with the new /code-review command.
- [Week 20 · May 11–15, 2026](https://code.claude.com/docs/en/whats-new/2026-w20.md): Manage every Claude Code session from one screen with agent view, keep Claude working toward a goal until a condition holds, and run fast mode on Opus 4.7 by default.
- [Week 19 · May 4–8, 2026](https://code.claude.com/docs/en/whats-new/2026-w19.md): Load plugins from .zip archives and URLs, search command history across every project with Ctrl+R, branch new worktrees from local HEAD or the remote default, and block actions unconditionally with auto mode hard deny rules.
- [Week 18 · April 27 – May 1, 2026](https://code.claude.com/docs/en/whats-new/2026-w18.md): Claude Code on Windows runs without Git Bash, claude auth login accepts a pasted OAuth code when the browser callback can't reach localhost, claude project purge cleans up local state per project, and pasting a PR URL into /resume finds the session that created it.
- [Week 17 · April 20–24, 2026](https://code.claude.com/docs/en/whats-new/2026-w17.md): /ultrareview opens as a research preview, automatic session recaps when you return to a terminal, custom color themes you can build and ship in plugins, and a redesigned Claude Code on the web.
- [Week 16 · April 13–17, 2026](https://code.claude.com/docs/en/whats-new/2026-w16.md): Claude Opus 4.7 with the new xhigh effort level, Routines on Claude Code on the web, mobile push notifications that ping your phone when Claude needs you, a /usage breakdown that shows what's driving your limits, and native binaries replacing the bundled JavaScript.
- [Week 15 · April 6–10, 2026](https://code.claude.com/docs/en/whats-new/2026-w15.md): Ultraplan cloud planning, the Monitor tool with self-pacing /loop, /team-onboarding for packaging your setup, and /autofix-pr from your terminal.
- [Week 14 · March 30 – April 3, 2026](https://code.claude.com/docs/en/whats-new/2026-w14.md): Computer use in the CLI, interactive in-product lessons, flicker-free rendering, per-tool MCP result-size overrides, and plugin executables on PATH.
- [Week 13 · March 23–27, 2026](https://code.claude.com/docs/en/whats-new/2026-w13.md): Auto mode for hands-off permissions, computer use built in, PR auto-fix in the cloud, transcript search, and a PowerShell tool for Windows.

## Resources

### Resources

- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md): Legal agreements, compliance certifications, and security information for Claude Code.

> The links below point to documentation indexes. Follow each `/_llms/` index recursively until you reach documentation pages.

## Indexes

- [French (166 pages)](https://code.claude.com/docs/_llms/fr.md): Documentation for French.
- [German (166 pages)](https://code.claude.com/docs/_llms/de.md): Documentation for German.
- [Italian (166 pages)](https://code.claude.com/docs/_llms/it.md): Documentation for Italian.
- [Japanese (166 pages)](https://code.claude.com/docs/_llms/jp.md): Documentation for Japanese.
- [Spanish (166 pages)](https://code.claude.com/docs/_llms/es.md): Documentation for Spanish.
- [Korean (166 pages)](https://code.claude.com/docs/_llms/ko.md): Documentation for Korean.
- [Chinese (166 pages)](https://code.claude.com/docs/_llms/cn.md): Documentation for Chinese.
- [Traditional Chinese (166 pages)](https://code.claude.com/docs/_llms/zh-hant.md): Documentation for Traditional Chinese.
- [Russian (166 pages)](https://code.claude.com/docs/_llms/ru.md): Documentation for Russian.
- [Indonesian (166 pages)](https://code.claude.com/docs/_llms/id.md): Documentation for Indonesian.
- [Brazilian Portuguese (166 pages)](https://code.claude.com/docs/_llms/pt-br.md): Documentation for Brazilian Portuguese.
