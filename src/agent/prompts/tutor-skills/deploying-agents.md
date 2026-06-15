---
name: deploying-agents
description: Tutor-only guide for helping new Letta Code users choose where an agent should run: local mode, Desktop, Constellation, remote environments, VMs, Railway, Fly.io, DigitalOcean, or other always-on hosts.
license: MIT
---

# Deploying agents

Use this when a user asks where their Letta Code agent should live, how to make it reachable from another machine, or whether to use Local mode, Constellation, a cloud VM, Railway, Fly.io, DigitalOcean, Vercel, Modal, or a similar host.

## Mental model

Separate these ideas before giving instructions:

- **Agent state**: the agent's identity, memory, conversations, and configuration.
- **Runtime**: the Letta Code process currently executing work for that agent.
- **Interface**: where the user talks to the agent: Desktop, CLI, `chat.letta.com`, or a channel.
- **Remote environment**: another machine running `letta server --env-name "..."` so an agent can work there.
- **Always-on host**: a machine or service that keeps a listener/server process alive for schedules and channels.

A user does not usually "deploy the brain". They choose where the state is stored, then choose which processes are allowed to operate on that state.

## First decision: local or Constellation

Recommend this decision tree:

1. **Stay local** when the user wants a private single-machine setup, is exploring, or does not need `chat.letta.com`, cross-machine access, hosted state sync, remote environments, or shared secrets.
2. **Use Constellation** when the user wants the same agent available from Desktop, CLI, `chat.letta.com`, other machines, remote environments, or channel/listener setups.
3. **Use a remote environment** when the agent needs to run on a different machine with specific files, GPUs, credentials, network access, or uptime.
4. **Use an always-on host** when schedules or channels must keep working after the laptop sleeps.

If the user is unsure, start local for learning and move to Constellation when they need another interface or machine.

## Host recommendations

For always-on Letta Code work, prefer a normal long-running process:

- A spare machine or Mac mini.
- A VPS.
- Railway, Fly.io, or DigitalOcean when supported by the current docs.
- A server where `letta server --env-name "..."` or `letta listen` can keep running.

Be cautious with request/response serverless platforms:

- **Vercel Functions / serverless functions** are usually the wrong shape for channels and listeners because they do not provide a durable always-on process.
- **Modal or job-style compute** can be useful for bursty jobs, but do not recommend it as the default channel/listener host unless the user has a specific Modal design that keeps the listener semantics intact.

If the exact hosting guide matters, search the current Letta docs before giving provider-specific commands.

## Recommended answers by user goal

- "I want to use the agent only on this laptop" → Local mode or Desktop is enough.
- "I want to chat from my phone/browser" → Constellation plus `chat.letta.com` or a channel.
- "I want the same agent on my laptop and server" → Constellation agent plus a named remote environment.
- "I want Telegram/Slack/Discord to work while my laptop is closed" → Constellation plus an always-on listener/channel host.
- "I need access to files on a server" → Run the runtime on that server as a remote environment.
- "I want a one-off coding job on a fresh machine" → A remote environment or coding subagent may be enough; do not overbuild an always-on deployment.

## Tutor workflow

1. Ask for the user's goal in one concrete sentence if it is not already clear.
2. State the recommended surface and why.
3. Explain what remains local vs synced vs always-on.
4. Give the minimum next command or UI action.
5. If channels or always-on behavior are involved, load `building-a-claw` next.
6. If custom channel development is involved, load `creating-channels` next.

## Verification habit

Do not guess on current provider-specific deployment steps, pricing, or real-time availability. Check the repo docs or docs.letta.com when the exact commands matter.
