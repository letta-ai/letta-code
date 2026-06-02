---
name: letta-help
description: Guides users through an interactive Letta Code onboarding/tutorial. Use when the user is new, unsure what to do, says "start", asks "what can you do?", "how does Letta work?", "help me get started", or needs a walkthrough of memory, skills, tools, search, subagents, or schedules.
---

# Letta Help

Use this skill to tutor a user through Letta Code one step at a time, starting with relationship rather than output. The larger goal is delegation literacy: helping users learn how to hand work to agents clearly, often, and without needing a perfect prompt.

## Core rule

Reduce choice paralysis. Do not ask broad questions like "what are you working on?" or "what do you want to do?" when the user is new or unsure.

Start by helping the user meet the agent. Do not rush into work, preferences, or a feature tour.

Then guide the next small step for them. Let them decline any item, but do not let a decline end the tutorial: move to the next onboarding item.

Your default stance is proactive progression. If an `onboarding` memory block exists, treat it as the source of truth for what remains, and work its items in order. On each onboarding turn, pick the first item that is not yet done and do one of three things: perform it, ask the smallest question required to perform it, or explain the capability and offer the concrete action that would complete it. Never end with generic support questions like "how can I help?" or "what would you like to do?" while onboarding items remain. If memory sync or checklist updates fail, continue the conversational tutorial anyway; failure to update the checklist is not permission to abandon onboarding. Never say "I'll sort that out later" about memory sync during onboarding.

Default path when the user is passive: ask what to call them → ask for one preference to remember → teach delegation with one messy example → show files/tools with permission → introduce skills → introduce search/subagents → introduce schedules. Treat any decline — "skip", "pass", "next", "no thanks", "rather not", "later", or similar — as a request to move on. If the user declines the name question, do not save memory for that item; acknowledge briefly ("No problem") and move directly to the preference question.

Teach delegation by doing it. When the user gives a rough request, help turn it into an agent-sized handoff with four parts:

- outcome: what should be true when the agent is done
- context: what the agent needs to know or inspect
- boundaries: what the agent may or may not do yet
- done signal: what the agent should return

Do not present this as a prompt-engineering lecture. Model it in conversation.

## Opening move

If this is first contact or the user says hello/start/get me started, introduce yourself naturally under your current persona and ask the user to introduce themselves:

```text
Hi, I'm <name>. I'm here to help you get comfortable with Letta and with me.

Before we do anything, what should I call you? You can also tell me a little about yourself if you want.
```

Keep it short. Stop after the prompt only on the very first message. On the next user reply, continue immediately to memory/preference onboarding rather than asking a broad support question.

## Tutorial flow

Move through this sequence proactively. Do not dump the full sequence unless the user asks for a roadmap, but do keep advancing through the checklist. If the user gives a one-word answer, says "skip", or seems unsure, acknowledge it and continue to the next smallest onboarding step.

### 1. Introduction

Goal: start a relationship before producing work.

Ask what to call the user. If they share a name, nickname, role, or anything personal, acknowledge it naturally.

When the user gives a name or nickname, make the memory mechanism visible:

1. Say what happened: they gave you information worth keeping.
2. Say what you are about to do: save it to memory so you can use it later.
3. Call the available memory mechanism/tool.
4. Confirm the saved fact in plain language.

Only save what the user explicitly provided. Do not save inferred identity, git config, repo context, email addresses, or assumptions about role/team unless the user confirms them.

Example:

```text
Nice to meet you, Sam. You just gave me something worth remembering: what to call you. I'm going to save that to memory so I can use it in future conversations.
```

Then call memory to save: `Call the user Sam.`

After the tool call:

```text
Saved. That's one of the core Letta ideas: I can carry useful context forward instead of starting over every time.
```

Do not follow this by asking "what are you working on?" or another broad intake question. Continue the walkthrough.

Avoid these immediately after the first memory save:

- "What brings you here?"
- "What's on your mind?"
- "What do you want to do?"
- "How can I help?"

Good follow-up:

```text
Next I'll show you one more kind of memory: preferences. Tell me one small way you'd like me to help — for example, shorter answers, more explanation, or commands first. Or say "skip" and we'll keep moving.
```

If the memory write reports a local/remote sync problem, say only what is true. Do not promise to fix sync later unless you are about to take that action.

If the user declines the name question (skip, pass, rather not, no thanks, later, or similar), do not call memory for the declined name. Continue with: "No problem. Next I'll show you preference memory. Tell me one small way you'd like me to help — shorter answers, more explanation, commands first — or just say pass and we'll keep moving."

### 2. Memory

Goal: show that Letta agents persist and improve.

After introductions, ask for one small durable preference. If the user gives one, save it to memory using the available memory mechanism for the current environment. Then say where it went in plain language.

Example:

```text
Got it — I'll remember that you prefer commands first, then explanation. That means next time I help with setup, I'll lead with the exact command before the reasoning.
```

If the user declines (skip, pass, rather not, or similar), move on to delegation without making it weird.

### 3. Delegation literacy

Goal: teach the user how to hand off work to an agent at high frequency.

After the first memory moments, show the basic delegation pattern:

```text
The basic way to use me is to hand me something rough, then let me help shape it into a task. A good handoff usually says: what you want, what context matters, what I should not do yet, and what kind of answer counts as done.
```

Then invite a small delegation:

```text
Give me something small to practice on: a question, a bug, a file, an idea, or a thing you want explained. It can be messy. I'll turn it into a clear handoff before I act.
```

When the user gives something rough, reflect it back as a delegation before acting:

```text
I'll treat that as: investigate why X is happening, look only at Y for now, don't edit files yet, and report the likely cause plus one next step. Sound right?
```

If the task is obviously safe and small, you can proceed after the reflection. If it involves broad scans, file edits, memory import, external messages, or background work, ask permission first.

### 4. Context briefing

Goal: teach that agents work better with useful context, without demanding a polished brief.

Ask for one messy task or fragment:

```text
Next: give me one messy thing. It can be a bug, an idea, a file path, or a half-formed goal. I'll show you how I turn rough context into a useful next step.
```

Reflect back the task in one or two sentences before acting.

### 5. Files and tools

Goal: show that Letta Code can work in the user's environment.

If they mention a project, file, repo, terminal output, or error, ask permission to inspect the smallest relevant thing. Prefer one file/path/command over broad scans.

### 6. Skills

Goal: show that repeated workflows can become reusable procedures.

Look for repetition. If the user describes a recurring workflow, say:

```text
This sounds repeatable. If we do it again, I can turn it into a skill so future-me follows the same procedure without you re-explaining it.
```

Create or update a skill only when the repeated workflow is clear enough.

### 7. Search, subagents, and schedules

Introduce only when useful:

- Search: when information is missing.
- Subagents: when work can split or needs background research.
- Schedules: when the user says remind me, later, every morning, periodically, or similar.

Name the capability briefly, then use it.

## If the user asks "how does Letta work?"

Start with the smallest useful picture, not a full architecture lecture:

```text
Smallest useful picture: a Letta agent is a model plus durable context. The model can change, but the agent's memory and history carry forward. That's why you can teach it preferences, workflows, and project context over time.

Let's make that concrete with memory first.
```

Then continue to the memory step.

## If the user asks "how do I use Letta?"

If they have already introduced themselves, do not restart the greeting/name step. Offer a short guided tutorial and start with delegation.

Good shape:

```text
Let's do the short version as a walkthrough.

You've already seen the first piece: memory. I can keep useful facts, like what to call you, across conversations.

Next, the basic way to use Letta is delegation: give me something real but rough — a question, a bug, a file, an idea, or a thing you want to understand — and I'll help turn it into a clear handoff. Along the way I'll point out when I'm using memory, tools, skills, search, or subagents.

I'll walk through memory, delegation, files/tools, skills, search, subagents, and schedules one at a time.
```

Then continue with the next concrete onboarding step unless the user explicitly asks to pause. Do not wait for them to choose a path.

If they have not introduced themselves yet, start with the introduction step first.

## If the user asks "what can you do?"

Answer with one sentence, then start the tutorial:

```text
I can help with coding, debugging, writing, research, memory, repeatable workflows, and scheduled follow-ups — but the easiest way to understand it is one step at a time.

First: memory...
```

## Avoid

- "Paste any context."
- "How can I help?"
- "What would you like to do next?" while onboarding items remain.
- Project-intake pivots before delegation practice, including asking what the user is working on as the first substantive prompt.
- Broad menus of options.
- Capability dumps.
- Asking the user to choose user/builder/contributor mode before they know the territory.
- Visible internal tags, todos, or thought JSON.
- Broad filesystem scans before permission.
- Waiting for the user to invent the tutorial path.
