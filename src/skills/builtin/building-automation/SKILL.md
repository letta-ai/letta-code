---
name: building-automation
description: Use this skill when you notice work you can automate. It shows how to extend yourself with one-off and recurring workflows built on the Letta Agent SDK.
---

# Building Automation

You can use the Letta Agent SDK to automate parts of your own work. A program can call you in another conversation, resume work later, run your tools on a selected computer, and return the result to your user. The same program can also ask other agents to help with separate parts of the work.

## Ways to automate yourself

An automation can take many forms:

- A one-off helper that runs when you or your user asks for it.
- A reusable command that handles a familiar task.
- A scheduled program that checks something at an interval.
- An event-driven program that sends GitHub, Linear, file, or product events to you.
- A service that keeps conversations active across a longer process.
- A skill with instructions and scripts that you call during normal work.

These forms can use the same agent and the same code. A one-off helper can later run from a schedule or event source without changing the agent that does the work.

## Instructions, code, and agents

The parts of an automation can be split in different ways:

- **Instructions** can describe judgment, such as how you review a pull request or decide which issue needs attention.
- **Code** can handle fixed work, such as collecting files, parsing events, tracking progress, or formatting results.
- **An agent turn** can interpret new information, use tools, and decide what to do next.

For example, a pull request automation can use a script to collect the diff and test results. It can then ask you to review the evidence with your existing knowledge of the project.

## Use your own agent

Your agent ID gives an Agent SDK program access to your persistent memory and identity. The program can use:

- Your default conversation.
- A new conversation for one isolated task.
- A saved conversation that continues across several runs.
- A conversation for each long-lived resource, such as a pull request or customer.

This lets an automation reuse what you already know. The program can send fresh evidence with each turn and keep the conversation ID when it wants to continue the same thread later.

A non-default conversation can select a different model when the program creates or resumes its session. This lets routine automation use a lower-cost model while the agent keeps the same memory and identity. Another conversation can use a different model for work that benefits from it.

The [Agent SDK recipes](references/sdk-recipes.md) show TypeScript examples for calling an existing agent, saving conversation IDs, and reporting results back to a main conversation.

## Use other agents

Other agents can help when a task benefits from separate context, another model, parallel work, or an independent opinion. An automation can use:

- **Another conversation on your agent:** the worker shares your memory and identity but has a separate thread.
- **A temporary worker agent:** the worker receives one task, uses a selected model and toolset, returns a result, and can then be deleted.
- **A persistent specialist agent:** the worker keeps its own memory and role across repeated tasks.

A TypeScript program can hold the loop, branching, concurrency, and intermediate results. Worker agents can read, search, edit, or review within that program.

The dynamic workflow examples in [letta-agent-sdk#261](https://github.com/letta-ai/letta-agent-sdk/pull/261) show several patterns:

- Audit files in parallel, then ask other workers to verify each finding.
- Run a check, ask workers to fix separate failures, and run the check again.
- Ask workers on different models for plans, then ask another agent to judge and combine them.
- Search from several angles and ask other workers to verify the claims.
- Give workers separate cloud sandboxes and collect their reviewed patches.

These examples also show per-worker models, tool lists, permissions, structured output, concurrency limits, and cleanup.

## Agent SDK options

An automation can use the following Agent SDK features:

- Persistent agents and conversations.
- Managed cloud sandboxes.
- Connected computers and local execution.
- Streaming reasoning, tool calls, tool results, and final responses.
- Client-side and server-side tools.
- Tool approval and permission callbacks.
- Conversation-level model selection.
- Different models for different workers.
- Structured results for script-controlled workflows.

## Choose where tools run

A [computer](https://docs.letta.com/platform/computers) is the environment where an agent runs commands, accesses files, and uses local tools. The agent's identity, memory, and conversations are separate from the computer. Moving the agent does not copy project files, software, or credentials. The agent can use what exists on the selected computer.

An Agent SDK automation can choose among:

- **Managed cloud sandbox:** use `backend: "cloud"` without a `computer`. Letta creates an isolated environment for the session. Provisioning adds cold-start time, which can make short tasks feel slow. Sandboxes fit automations that need isolation, clean environments, or many concurrent workers. Letta expects their startup time and usability to improve.
- **Computer in your Letta organization:** use `backend: "cloud"` with a `computer` selector. The computer can be an online laptop, workstation, VM, or other connected machine. This option gives the agent access to a specific filesystem, credential, dependency, or long-running machine. A `deviceId` or computer `id` is stable across reconnects. A `connectionId` represents one live connection.
- **Current computer:** use `backend: "local"` to keep agent state and tool execution on the machine running the program. This is useful for direct access to local files and tools or for a fully local deployment.

The program can discover online organization computers with `client.computers.list({ onlineOnly: true })`. A Cloud session can use a selected `computer` or a managed `sandbox`, but not both. A separately operated App Server is available through `backend: "remote"`.

One program can open separate conversations on several organization computers. This can support fleets of CI machines, infrastructure nodes, platform-specific test machines, or other connected computers.

## Questions that can help

The following questions can help describe the automation:

- What part of your work would the program handle?
- What starts it: a request, command, schedule, or event?
- Does it call you, another conversation on you, or another agent?
- Which information needs to continue across runs?
- Which model and tools fit each part of the work?
- Where will the tools run?
- How will the result return to you or your user?

## State options

An automation can use several types of state:

- **Agent memory** for knowledge that remains useful across conversations.
- **Conversation history** for decisions and context in one thread of work.
- **Files or a database** for event cursors, queues, timestamps, retry counts, and records of external actions.

## Execution and authority options

The surrounding program can run from a command, scheduled task, server, or another application. Its tools run on the computer selected for each session.

The automation can read information, draft an action, ask for approval, or perform actions that the user has authorized. Session options can give each worker its own model, tool list, permission mode, working directory, and sandbox.

## Storage and operations

A skill can keep the instructions and source files together. Common directories include `scripts/`, `src/`, `tests/`, `fixtures/`, and `templates/`. Runtime state and credentials can live in storage selected for the automation.

Repeated or deployed automations can also use run history, idempotency records, cost and concurrency limits, ownership information, health checks, and stop commands. [Operations options](references/operations.md) describes these pieces.
