# Letta Code

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-code.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-code) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

Letta Code is a memory-first agent harness, designed for long-lived agents that can learn from experience and maintain a cohesive identity across models (Claude, GPT, Gemini, GLM, Kimi, and more). 

You can interact with Letta Code agents through:
* A local [**CLI**](https://docs.letta.com/letta-code/cli)
* The [**desktop app**](https://docs.letta.com/letta-code/desktop-app) for macOS, Windows, and Linux
* Your browser, including [mobile](https://docs.letta.com/letta-code/remote-mobile), at [chat.letta.com](https://chat.letta.com)
* Messaging integrations, including [Telegram](https://docs.letta.com/letta-code/channels#telegram-cli), [Slack](https://docs.letta.com/letta-code/channels#slack-cli), [Discord](https://docs.letta.com/letta-code/channels#discord-cli), and [custom channels](https://github.com/letta-ai/letta-code/blob/main/src/channels/README.md)

Letta Code is a frontier coding agent and can also be used as a long-lived personal agent. 

![](https://github.com/letta-ai/letta-code/blob/main/assets/letta-code-demo.gif)

## Feature Overview 
> [!TIP]
> Letta Code agents are designed to be self-configuring. If you want to configure something (e.g. skills, behavior, hooks, permissions), try asking your agent to do it for you. 

| Feature | Description |
|---|---|
| [Self-improvement & Learning](https://docs.letta.com/letta-code/self-improvement) | Agents programmatically rewrite their context to improve and adapt over time, including system prompt learning (through [memory blocks](https://www.letta.com/blog/memory-blocks)) and [skill learning](https://www.letta.com/blog/skill-learning). Configure periodic dreaming with `/sleeptime`, audit memory quality with `/doctor`, and view memory with `/palace`   |
| [Message search](https://docs.letta.com/letta-code/conversation-search) | Search across all messages and agents with `/search`. Agent can also search their own conversations or the conversations of other agents |
| [MemFS](https://docs.letta.com/letta-code/memfs) | All context (including memory blocks) is tracked via git. Sync context to a custom GitHub repository by setting `/memory-repository set git@github.com:...` |
| [Skills](https://docs.letta.com/letta-code/skills) | Loads global skills (`~/.letta`), project-scoped skills (`.agents/skills`), and agent-scoped skills (stored in MemFS). View skills with `/skills` and create with `/skill-creator` |
| [Subagents & Multi-agent](https://docs.letta.com/letta-code/subagents) | Call built-in subagents (general-purpose, forked, recall, history-analyzer) async or sync. Agents can call any other agent (including themselves) as subagents  |
| [Messaging Integrations](https://docs.letta.com/letta-code/channels) | Chat with the same agent from Slack, Telegram, your browser (chat.letta.com) including mobile, and through [custom channels](https://github.com/letta-ai/skills/blob/main/letta/creating-letta-code-channels/SKILL.md) |
| [Hooks](https://docs.letta.com/letta-code/hooks) | Run custom scripts at key points of agent execution to automate workflows |
| [Permissions](https://docs.letta.com/letta-code/permissions) | Set permission modes and customize what actions are auto-approved or auto-denied |
| [Crons & Schedules](https://docs.letta.com/letta-code/scheduling) | Configure heartbeats and crons, and let agents work across time with self-managed schedules |
| [Remote & Multi-Env](https://docs.letta.com/letta-code/client-server-architecture) | Agents work across multiple environments. Make any machine available as a remote environment by running `letta server --env-name "..."`|
| [Secrets](https://docs.letta.com/letta-code/secrets) | Make secrets available as environment variables (across machines) while obfuscating their values from context |

See the full list of slash commands in our [documentation](https://docs.letta.com/letta-code/slash-commands).

## Get started
Install the package via [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm):
```bash
npm install -g @letta-ai/letta-code
```
Navigate to your project directory and run `letta` (see command-line options [in the docs](https://docs.letta.com/letta-code/commands)). If you do not already have Letta Cloud credentials configured, Letta Code starts in local mode by default so you can begin without signing in.

To sign into Letta Cloud, run `letta setup` and choose **Login to Constellation**, or set the default backend directly with `letta backend api`. Use Letta Cloud when you want the same agents available from `chat.letta.com`, the desktop app, other machines, and messaging integrations.

Run `/connect` to configure your own LLM API keys (OpenAI / ChatGPT, Anthropic, zAI coding plan, etc.), and use `/model` to swap models.

For slow local inference servers, configure a provider-level timeout when connecting. For example, LM Studio-compatible llama-server backends that need up to 10 minutes for large-context compaction can use:

```bash
letta --backend local connect lmstudio --base-url http://127.0.0.1:1234/v1 --timeout 600s
```

Timeouts are stored per local provider in milliseconds; pass `--no-timeout` or `--timeout false` to disable the provider timeout.

You can also download the [**desktop app**](https://docs.letta.com/letta-code/desktop-app) for MacOS, Windows, and Linux. Agents created in the CLI are available via the desktop app, and vice versa.

## Local mode
Local mode runs an embedded Letta-compatible backend inside Letta Code. Agents, conversations, memory, provider connections, and secrets are stored on your machine.

Local mode is a good fit when you want:

* A self-contained agent runtime for local projects
* Disposable agents for experiments or development
* Inspectable state stored as ordinary local files
* Local git-backed MemFS memory
* Direct provider connections from your machine

Local mode means local **state**, not necessarily local **inference**. If you connect a remote provider like OpenAI, Anthropic, Gemini, OpenRouter, Bedrock, or ChatGPT/Codex, prompts still go to that provider. For a fully local loop, connect a local inference provider like Ollama, LM Studio, or llama.cpp.

You can enter local mode from the first-run setup menu, or explicitly with:

```bash
letta --backend local
```

To switch your default back to Letta Cloud after choosing local mode, re-run setup or set the default backend directly:

```bash
letta setup
letta backend api
```

Use `letta --backend api` for a one-off Letta Cloud launch without changing your saved default.

Connect a provider from inside the TUI with `/connect`, or from the shell with `letta --backend local connect`:

```bash
letta --backend local connect anthropic --api-key "$ANTHROPIC_API_KEY"
letta --backend local connect ollama
letta --backend local connect lmstudio
letta --backend local connect llama-cpp
letta --backend local connect chatgpt
```

Then create a local agent:

```bash
letta --backend local --new-agent --model anthropic/claude-sonnet-4-6
```

Local backend state is stored by default in:

```text
~/.letta/lc-local-backend
```

You can override this location for isolated experiments:

```bash
export LETTA_LOCAL_BACKEND_DIR="$PWD/.letta-local"
letta --backend local --new-agent
```

Local agents do not appear in Letta Cloud, but their memory is still a normal git repository under `~/.letta/lc-local-backend/memfs/<agent-id>/memory`.

## Connecting to Letta Cloud
Letta Code agents are *stateful*: memory, identity, and conversation history persist across sessions. State can live in either:

* **Local mode**: local storage on the current machine, best for local-first or privacy-sensitive work
* **Letta Cloud**: remote state so agents can follow you across devices, environments, and communication channels

Letta Cloud allows your agents to work on any machine while maintaining the same cohesive memory, identity, and experience. Agents in Letta Cloud can be accessed from the CLI, desktop app, browser, mobile, or messaging integrations. Any machine can also be connected as a remote environment by running `letta server` on it.

```mermaid
graph TD
    LettaCloud["☁️ Letta Cloud"]
    LettaCloud --> A["💻 Your Laptop"]
    LettaCloud --> B["🌐 Browser / Mobile"]
    LettaCloud --> C["🖥️ Mac Mini"]
    LettaCloud --> D["📦 Sandbox"]
```

## Philosophy
Letta Code is built around long-lived agents that persist across sessions and improve with use. Rather than working in independent sessions, each session is tied to a persisted agent that learns.

**Claude Code / Codex / Gemini CLI** (Session-Based)
- Sessions are independent
- No learning between sessions
- Context = messages in the current session + `AGENTS.md`
- Relationship: Every conversation is like meeting a new contractor

**Letta Code** (Agent-Based)
- Same agent across sessions
- Persistent memory and learning over time
- `/new` starts a new conversation (aka "thread" or "session"), but memory persists
- Relationship: Like having a coworker or mentee that learns and remembers

## Agent Memory & Learning
If you’re using Letta Code for the first time, you will likely want to run the `/init` command to initialize the agent’s memory system:
```bash
> /init
```

Over time, the agent will update its memory as it learns. To actively guide your agents memory, you can use the `/remember` command:
```bash
> /remember [optional instructions on what to remember]
```
Letta Code works with skills (reusable modules that teach your agent new capabilities in a `.skills` directory), but additionally supports [skill learning](https://www.letta.com/blog/skill-learning). You can ask your agent to learn a skill from its current trajectory with the command:
```bash
> /skill [optional instructions on what skill to learn]
```

## Remote environments
Letta Code agents in Letta Cloud can connect to remote environments. Run `letta server` on a machine to register it as an environment, then use the CLI, desktop app, web app, or messaging integrations to route agent work there.

```bash
letta server
letta server --env-name "work-laptop"
```

## Messaging Integrations
Letta Code supports [channels](https://docs.letta.com/letta-code/channels).
```bash
letta channels configure telegram
letta server --channels telegram
```

Read the docs to learn more about [skills and skill learning](https://docs.letta.com/letta-code/skills).

Community maintained packages are available for Arch Linux users on the [AUR](https://aur.archlinux.org/packages/letta-code):
```bash
yay -S letta-code # release
yay -S letta-code-git # nightly
```

---

Made with 💜 in San Francisco
