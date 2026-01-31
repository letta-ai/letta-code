# Letta Code

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-code.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-code) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

Letta Code is a memory-first coding harness, built on top of the Letta API. Instead of working in independent sessions, you work with a persisted agent that learns over time and is portable across models (Claude Sonnet/Opus 4.5, GPT-5.2-Codex, Gemini 3 Pro, GLM-4.7, and more).

**Read more about how to use Letta Code on the [official docs page](https://docs.letta.com/letta-code).**

![](https://github.com/letta-ai/letta-code/blob/main/assets/letta-code-demo.gif)

## Get started
Install the package via [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm):
```bash
npm install -g @letta-ai/letta-code
```
Navigate to your project directory and run `letta` (see various command-line options [on the docs](https://docs.letta.com/letta-code/commands)). 

Run `/connect` to configure your own LLM API keys (OpenAI, Anthropic, etc.), and use `/model` to swap models.

> [!NOTE]
>  By default, Letta Code will to connect to the [Letta API](https://app.letta.com/). Use `/connect` to use your own LLM API keys and coding plans (Codex, zAI, Minimax) for free. Set `LETTA_BASE_URL` to connect to an external [Docker server](https://docs.letta.com/letta-code/docker).

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
- `/clear` starts a new conversation (aka "thread" or "session"), but memory persists
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
Letta Code works with skills (reusable modules that teach your agent new capabilities in a `.skills` directory), but additionally supports [skill learning](https://www.letta.com/blog/skill-learning). You can ask your agent to learn a skill from it's current trajectory with the command: 
```bash
> /skill [optional instructions on what skill to learn]
```

Read the docs to learn more about [skills and skill learning](https://docs.letta.com/letta-code/skills).

Community maintained packages are available for Arch Linux users on the [AUR](https://aur.archlinux.org/packages/letta-code):
```bash
yay -S letta-code # release
yay -S letta-code-git # nightly
```

---

Made with 💜 in San Francisco
