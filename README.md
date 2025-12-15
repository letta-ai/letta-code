# Letta Code (Research Preview)

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-code.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-code) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

Letta Code is a self-improving, stateful coding agent that can learn from experience and improve with use. You can use Letta Code as a general purpose **CLI harness** to connect any Letta agent (even non-coding agents!) to your local dev environment.

Letta Code is fully **open source** and **model agnostic** - supporting Claude Sonnet/Opus, GPT-5, Gemini 3 Pro, GLM-4.6, and more.

**Read more about how to use Letta Code on the [official docs page](https://docs.letta.com/letta-code).**

![](https://github.com/letta-ai/letta-code/raw/main/assets/demo.gif)

> [!IMPORTANT]
> Letta Code is a **research preview** in active development, and may have bugs or unexpected issues. To learn more about the roadmap and chat with the dev team, visit our [Discord](https://discord.gg/letta). Contributions welcome, join the fun.

## Get started

Requirements: 
* [Node.js](https://nodejs.org/en/download) (version 18+)
* A [Letta Developer Platform](https://app.letta.com/) account (or a [self-hosted Letta server](https://docs.letta.com/letta-code/configuration#self-hosted-server))

Install the package via [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm):
```bash
npm install -g @letta-ai/letta-code
```

Then run `letta` to start Letta Code in interactive mode (see various command-line options [on the docs](https://docs.letta.com/letta-code/commands)):
```bash
letta
```
If you haven't used Letta Code before, you'll need to use OAuth to login, or set a `LETTA_API_KEY` in your environment variables.

To connect to an existing agent, use the `--agent` flag:
```bash
letta --agent [existing-agent-id]
```

You can also run Letta Code in headless mode, making it easy to integrate into scripts (see the [docs](https://docs.letta.com/letta-code/headless) for more):
```bash
letta -p "Look around this repo and write a README.md documenting it at the root level"
```

## Memory and Skill Learning

All agents in Letta are **stateful**: they maintain context forever and can self-edit their own [memory blocks](https://www.letta.com/blog/memory-blocks).

If you’re using Letta Code for the first time, you will likely want to run the `/init` command to initialize the agent’s memory system:
```bash
> /init
```

Over time, the agent will update its memory as it learns. To actively guide your agents memory, you can use the `/remember` command:
```bash
> /remember [optional instructions on what to remember]
```

Skills are reusable modules that teach your agent new capabilities. They’re automatically discovered from your project’s `.skills` directory and loaded into the agent’s memory at session start. The easiest way to create a skill is using the interactive skill creation mode:
```bash
> /skill
```

Read the docs to learn more about [skills and skill learning](https://docs.letta.com/letta-code/skills).

---

Made with 💜 in San Francisco
