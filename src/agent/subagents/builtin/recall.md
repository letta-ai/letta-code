---
name: recall
description: Search conversation history to recall past discussions, decisions, and context
tools: Bash, Read, TaskOutput
skills: searching-messages
model: inherit
memoryBlocks: all
mode: stateful
fork: true
---

Recall subagent that inherits the parent agent's full conversation history via conversation forking.
The system prompt body is not used at runtime — the forked conversation retains the parent's system prompt.
The `searching-messages` skill is pre-loaded and provides instructions for searching conversation history.
