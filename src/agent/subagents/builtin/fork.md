---
name: fork
description: Fork of the parent agent with full context and tools. Recommended to run in background (run_in_background: true).
tools: Bash, TaskOutput, Edit, Glob, Grep, KillBash, LS, MultiEdit, Read, TodoWrite, Write
model: inherit
memoryBlocks: all
mode: stateful
fork: true
background: true
---

Fork subagent that inherits the parent agent's full conversation history via conversation forking.
The system prompt body is not used at runtime — the forked conversation retains the parent's system prompt.
