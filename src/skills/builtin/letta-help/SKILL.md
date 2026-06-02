---
name: letta-help
description: Generic Letta Code help for non-Tutor agents. Use when a non-Tutor user asks what Letta can do, how Letta works, or how to get started. Tutor owns its onboarding flow directly through persona_tutorial.mdx and onboarding.mdx.
---

# Letta Help

This is a lightweight generic help skill for agents that are **not** the Tutor personality.

Tutor does not need this skill for its core job. If the current agent is Tutor, follow `persona_tutorial.mdx` and the `onboarding` memory block; do not start a separate tutorial flow from this skill.

## Core shape

Reduce choice paralysis. Give the user one small next step instead of a broad menu.

When a user is new, unsure, says "start", asks "what can you do?", "how does Letta work?", or "help me get started":

1. Answer the immediate question in one or two sentences.
2. Explain one capability only when it connects to the next action.
3. Invite a concrete next step.

Avoid generic endings like "how can I help?" when the user is asking how to begin.

## Useful explanations

### What Letta is

Smallest useful picture: a Letta agent is a model plus durable context. The model can change, but the agent's memory and history carry forward. That means the user can teach it preferences, workflows, project context, and recurring tasks over time.

### What Letta Code can do

Letta Code can help with coding, debugging, writing, research, memory, repeatable workflows, and scheduled follow-ups. The easiest way to understand it is to try one real task and notice which capabilities show up.

### How to delegate

A good handoff usually includes:

- outcome: what should be true when the agent is done
- context: what the agent needs to know or inspect
- boundaries: what the agent may or may not do yet
- done signal: what the agent should return

Do not present this as a prompt-engineering lecture. Model it briefly:

```text
That's enough to delegate. I'll treat it as: investigate why X is happening, look only at Y for now, don't edit files yet, and report the likely cause plus one next step.
```

## Good responses

If the user asks "what can you do?":

```text
I can help with coding, debugging, writing, research, memory, repeatable workflows, and scheduled follow-ups. Give me one small real thing — a question, bug, file, or rough idea — and I'll show you how I'd turn it into an agent-sized task.
```

If the user asks "how does Letta work?":

```text
Smallest useful picture: a Letta agent is a model plus durable context. The model can change, but memory and history carry forward, so the agent can learn preferences, projects, and workflows over time.
```

If the user asks "how do I use Letta?":

```text
Start rough. Give the agent a small real task, any context you have, any boundaries, and what kind of answer would count as done. The agent can help shape the handoff before acting.
```

## Avoid

- Long capability dumps.
- Asking the user to choose a mode before they know the territory.
- "Paste any context" as the first instruction.
- "What are you working on?" as the first substantive prompt for a new or unsure user.
- Broad filesystem scans before permission.
- Competing with Tutor's persona/onboarding checklist when the current agent is Tutor.
