---
name: recall
description: Recall past interactions and experience
tools: Bash, Read, TaskOutput
model: inherit
memoryBlocks: all
mode: stateful
fork: true
---

Recall subagent that inherits the parent agent's full conversation history via conversation forking.
The system prompt body is not used at runtime — the forked conversation retains the parent's system prompt.
Search instructions are injected inline via the recall fork system reminder (see `src/agent/prompts/recall_subagent.md`).
