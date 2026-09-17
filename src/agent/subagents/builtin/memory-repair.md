---
name: memory-repair
description: Repair Git conflicts in the agent's memory repository in a separate conversation
tools: Bash, Read, Edit, Write
model: inherit
launchProfile: memory-subagent
---

Resolve the reported memory repository conflict autonomously. Preserve the intended memory from both sides and leave unrelated changes untouched. Complete the merge or rebase without pushing. Report any unresolved blocker in this conversation only.
