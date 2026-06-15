---
name: building-a-claw
description: Tutor-only guide for teaching new users how to build a CLaw: a practical always-on Letta Code agent setup with state, runtime, channels, schedules, tools, secrets, and remotes wired together.
license: MIT
---

# Building a CLaw

Use this when a user wants an agent that keeps working after the interactive chat ends: scheduled tasks, channel replies, remote execution, background monitoring, or a persistent assistant reachable from outside the laptop.

A CLaw is the user's complete always-on agent setup. Teach it as a system, not as one magic deployment switch.

## Core model

Explain the parts in this order:

1. **Agent** — persistent state: memory, conversations, tools, model settings, and identity.
2. **Runtime** — a running Letta Code process that can execute tools for that agent.
3. **Trigger** — what wakes work up: user message, channel message, schedule, webhook, or manual CLI/Desktop action.
4. **Interface** — where messages enter and leave: Desktop, CLI, `chat.letta.com`, Slack, Discord, Telegram, or a custom channel.
5. **Host** — where the runtime stays alive: laptop, Desktop, VPS, remote environment, or another always-on machine.
6. **Secrets** — credentials made available as environment variables without pasting secret values into chat.
7. **Memory** — durable knowledge and skills the agent carries forward.

Then summarize: **state persists; runtimes come and go; always-on behavior requires a process that stays running.**

## Minimum viable CLaw

For a first setup, keep it small:

1. One primary agent.
2. MemFS enabled.
3. One always-on runtime or remote environment.
4. One interface/channel.
5. One trigger: either a schedule or inbound channel message.
6. Required secrets installed.
7. A short memory note saying what the CLaw is responsible for.

Do not start with five permanent agents. Use temporary subagents for bounded work; make more persistent agents only when ownership boundaries are clear.

## Channel CLaw

For Slack, Discord, Telegram, WhatsApp, or custom chat:

1. Confirm whether the user is connecting an existing first-party channel or building a custom channel plugin.
2. If building/debugging channel code, load `creating-channels`.
3. Ensure the listener/channel process will stay alive on an appropriate host.
4. Bind routes/pairing so inbound messages go to the intended agent/conversation.
5. Ensure outbound replies work through `MessageChannel` or the channel's native action.
6. Avoid posting approval prompts into public rooms unless operator routing is verified.

## Scheduled CLaw

For recurring work:

1. Define the smallest recurring task.
2. Confirm required tools, files, network access, and secrets.
3. Put the responsibility in memory.
4. Schedule the task.
5. Decide where the runtime executes if the laptop is asleep.
6. Add a reporting path: chat, channel, file, or notification.

## Remote CLaw

For remote execution:

1. Choose Constellation-backed state when the same agent needs to run across machines.
2. Run a named remote environment on the machine that has the required files or uptime.
3. Keep project-specific instructions in project memory or project skills.
4. Use worktrees for parallel coding work rather than multiple agents editing one checkout blindly.

## Common mistakes to prevent

- Treating "agent" and "running process" as the same thing.
- Expecting a laptop-hosted listener to work after the laptop sleeps.
- Deploying to a serverless function that cannot hold a persistent listener.
- Creating many permanent agents before responsibilities are stable.
- Pasting API keys into chat instead of using secrets/environment variables.
- Building a custom channel when a first-party channel or generic setup is enough.
- Forgetting outbound reply support when building a channel plugin.

## Tutor workflow

When teaching a CLaw, produce:

1. A one-sentence architecture recommendation.
2. A labeled diagram in text, for example:
   `Telegram -> listener on VPS -> Constellation agent state -> tools/secrets -> MessageChannel reply`.
3. The next single setup step.
4. The thing that must be tested before moving on.

Keep the first CLaw boring. A boring always-on agent that works is better than an elaborate fleet that nobody understands.
