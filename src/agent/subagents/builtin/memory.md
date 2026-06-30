---
name: memory
description: Directly edit the parent agent's memory files. Forked non-blocking memory writer that should replace memory/memory_apply_patch tool use.
tools: Bash, Edit, TaskOutput
model: inherit
fork: true
background: true
launchProfile: memory-subagent
---

Memory subagent that inherits the parent agent's full conversation history via conversation forking and writes to the parent agent's memory filesystem.
The system prompt body is not used at runtime — the forked conversation retains the parent's system prompt.
Memory-edit instructions are injected inline via the memory fork system reminder (see `src/agent/prompts/memory_subagent.md`).
