---
name: changing-default-system-prompts
description: Explains the default system-prompt subsystem in Letta Code and how a change to the default prompt reaches existing agents and new conversations. Use when editing or adding a rule in src/agent/prompts/letta*.md, changing the default prompt behavior, rolling out a prompt change to existing agents, or verifying that a prompt change actually took effect.
---

# Changing Default System Prompts

Default prompt changes cross three boundaries:

1. Edit the relevant bundled templates in `src/agent/prompts/letta*.md`; update every memory-mode variant the rule should affect.
2. Existing agents receive managed-template updates only while their stored `agent.system` still matches the previously installed hash. Custom or edited prompts are preserved.
3. Existing conversations keep their compiled system message. Verify the stored prompt, then start a new conversation to verify model input.

To explicitly reapply the bundled default to an agent:

```bash
letta --agent <agent-id> --system default
```

Custom presets and subagent-specific prompts are separate. For package/deployment rollout, use the existing release and deployment skills rather than duplicating those procedures here.
