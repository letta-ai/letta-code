Lists the agents this conversation launched with Agent, newest first. Each row carries the IDs SendAgentMessage takes: pass its `agent_id` and `conversation_id` exactly as listed (an external coding agent has only `agent_id`; a subagent running in an ephemeral conversation has `agent_id: null`, so pass only its `conversation_id`). Stop a running one with TaskStop and its `task_id`.

`status` is `running`, `completed`, `failed` or `stopped`, and the filter defaults to `["running"]`; pass every status you want (e.g. `["completed", "failed", "stopped"]`) to see finished ones. A finished agent can still be messaged; SendAgentMessage continues it with its context intact, while a new Agent call starts fresh.

You are notified when a background agent finishes. Never call ListSubagents in a loop or send "are you done?" messages to check on one.
