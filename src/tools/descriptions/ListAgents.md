Lists the agents this conversation launched with Agent, running and finished, newest first. Each row carries the IDs SendAgentMessage takes: pass its `agent_id` and `conversation_id` exactly as listed (an external coding agent has only `agent_id`). Stop a running one with TaskStop and its `task_id`.

`status` is `running`, `completed`, `failed` or `stopped`. A finished agent can still be messaged; SendAgentMessage continues it with its context intact, while a new Agent call starts fresh.

You are notified when a background agent finishes. Never call ListAgents in a loop or send "are you done?" messages to check on one.

`subagents_only: false` instead lists all agents you can access (`agent_id`, `name`, `model`), up to 50; `truncated: true` means more exist.
