---
name: fork
description: Fork of the parent agent with full context and tools.
tools: all
model: inherit
fork: true
---

Fork subagent that inherits the parent agent's full conversation history via conversation forking.
The system prompt body is not used at runtime — the forked conversation retains the parent's system prompt.
