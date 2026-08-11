---
name: building-automation
description: Load this skill to understand how to use the Letta Agent SDK to automate yourself by building one-off or repeated automations.
---

# Building Automation

Use this skill when you notice work that you or your user repeats. It explains ways to preserve the work and use the Letta Agent SDK when the automation needs an agent.

A useful split is:

- **Instructions preserve judgment.** A skill can store a review method, release process, or other procedure that still needs interpretation.
- **Code handles mechanics.** Scripts can collect data, format output, compare files, track cursors, and apply fixed rules.
- **The Agent SDK adds agents and orchestration.** It can connect code to persistent agents, conversations, tools, approvals, and execution environments.

These parts can be used together. For example, a skill can explain how to review a pull request, a script can collect the Git state, and an Agent SDK program can ask separate agents to review the change.

## Available forms

Repeated work can take several forms:

- **Instructions in a skill:** useful when judgment remains the main part of the work.
- **A skill with scripts:** useful when part of the work follows fixed steps.
- **A one-off program:** runs on request, asks an agent to do the work, returns a result, and exits.
- **A scheduled program:** runs the same program at a fixed time or interval.
- **An event-driven program:** sends events from GitHub, Linear, files, or another source to an agent.
- **A long-running service:** stays available when the automation needs low latency or continuous event handling.

An automation can start with one form and change later. It can also stay as instructions if code does not add value.

## Questions that can help

The following questions describe the main design choices:

- What starts the work: a person, a command, a schedule, or an event?
- Which parts follow fixed rules?
- Which parts need an agent to interpret the situation?
- Does the work need to continue after the current conversation ends?
- What state does it need between runs?
- Where will its tools run?
- Can it read information, draft changes, or perform external actions?
- How will the user see the result?

The answers can point to a script, an Agent SDK program, or a combination of both.

## What the Agent SDK provides

The Agent SDK is useful when the automation needs one or more of these features:

- A persistent agent with memory.
- Separate conversations for different tasks or resources.
- Streaming reasoning, tool calls, tool results, and final responses.
- Tools that run in a managed cloud sandbox, on a connected computer, or on the local machine.
- Tool approval and permission handling.
- A program that coordinates several agent conversations.

The SDK works well for both one-off programs and repeated services. The [Agent SDK recipes](references/sdk-recipes.md) show TypeScript patterns for these forms.

## State options

Different types of state fit in different places:

- **Agent memory** can store knowledge that the agent can use across conversations.
- **Conversation history** can store prior messages, decisions, and unresolved questions for one thread of work.
- **Files or a database** can store cursors, queues, timestamps, retry counts, and records of external actions.

An automation can use all three. The choice depends on how the state is used.

## Conversation options

An Agent SDK program can use:

- The agent's default conversation.
- A new conversation for each run.
- A conversation for each long-lived resource, such as a pull request or customer.
- One conversation for a group of related resources.
- A coordinator conversation that receives results from worker conversations.

Separate conversations are useful when their history helps future decisions. A database can hold resource mappings when the program only needs structured lookup data.

## Execution options

The Agent SDK supports several places for tool execution:

- **Managed cloud sandbox:** Letta Cloud creates a contained computer for the session.
- **Connected computer:** the agent runs tools on a selected remote environment.
- **Local backend:** the agent state and tools stay on the current machine.

The surrounding program can run from a command, a scheduled task, a server, or another application. The SDK connects that program to the agent and its execution environment.

## Authority options

An automation can have different levels of authority:

- Read information and report what it finds.
- Draft an external action for review.
- Ask for approval before an action.
- Perform actions that the user has already authorized.

The chosen level affects credentials, approvals, error handling, and reporting. A dry-run mode can show proposed actions before the automation performs them.

## Storage and sharing

A skill can keep the instructions and source files together. Common directories include `scripts/`, `src/`, `tests/`, `fixtures/`, and `templates/`. Runtime state and credentials can live in storage selected for the automation.

An automation can be personal to one agent, attached to a project, shared across agents, or prepared for public use. The same source can move between these scopes when its assumptions and credentials are clear.

## Operations

Repeated and deployed automations can also use run history, idempotency records, cost limits, ownership information, health checks, and stop commands. [Operations options](references/operations.md) explains these pieces and when they are useful.
