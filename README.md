# Letta Code

[![npm](https://img.shields.io/npm/v/@letta-ai/letta-code.svg?style=flat-square)](https://www.npmjs.com/package/@letta-ai/letta-code) [![Discord](https://img.shields.io/badge/discord-join-blue?style=flat-square&logo=discord)](https://discord.gg/letta)

Letta Code is a memory-first coding harness, built on top of the Letta API. Instead of working in independent sessions, you work with a persisted agent that learns over time and is portable across models (Claude Sonnet/Opus, GPT-5, Gemini 3 Pro, GLM-4.6, and more).

**Read more about how to use Letta Code on the [official docs page](https://docs.letta.com/letta-code).**

![](https://github.com/letta-ai/letta-code/blob/main/assets/letta-code-demo.gif)

## Get started

Requirements: 
* [Node.js](https://nodejs.org/en/download) (version 18+)
* A [Letta Developer Platform](https://app.letta.com/) account (or a [self-hosted Letta server](https://docs.letta.com/letta-code/configuration#self-hosted-server))

Install the package via [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm):
```bash
npm install -g @letta-ai/letta-code
```
Navigate to your project directory and run `letta` (see various command-line options [on the docs](https://docs.letta.com/letta-code/commands)):

## Philosophy 
Letta Code is built around long-lived agents that persist across sessions and improve with use. Rather than working in independent sessions, each session is tied to a persisted agent. You can reset a session by using `/clear` to wipe the current in-context messages, but otherwise new sessions will continue a conversation with an existing agent.

Why tie sessions to persistent agents? This lets you treat agents like mentees: you can train your agents through teaching them and encouraging to reflect on their experiences. You may want to have multiple agents focused on learning about different projects, so you can pin your go-to agents with `/pin`. To view your pinned agents, you can do 
```
> /pinned 
```
## Training Agents 
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

---

Made with 💜 in San Francisco
