# Letta Code

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-code.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-code) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

Letta Code is a memory-first coding harness, built on top of the Letta API. Instead of working in independent sessions, you work with a persisted agent that learns over time and is portable across models (Claude Sonnet/Opus, GPT-5, Gemini 3 Pro, GLM-4.6, and more).

**Read more about how to use Letta Code on the [official docs page](https://docs.letta.com/letta-code).**

![](https://github.com/letta-ai/letta-code/blob/update-gif/assets/letta-code-demo.gif)

## Get started

Requirements: 
* [Node.js](https://nodejs.org/en/download) (version 18+)
* A [Letta Developer Platform](https://app.letta.com/) account (or a [self-hosted Letta server](https://docs.letta.com/letta-code/configuration#self-hosted-server))

Install the package via [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm):
```bash
npm install -g @letta-ai/letta-code
```
Navigate to your project directory and run `letta` (see various command-line options [on the docs](https://docs.letta.com/letta-code/commands)):

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
