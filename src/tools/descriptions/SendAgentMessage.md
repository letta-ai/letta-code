# SendAgentMessage

Send a message without waiting for its answer. Letta-to-Letta messages require
the Cloud backend and fail on the local backend (`agent-local-` IDs). Use this
to coordinate with an agent already working, including an Agent child, or to
contact any conversation you are authorized to access.

Claude Code and Codex workers return synthetic `claude_...` and `codex_...`
agent IDs backed by their native sessions. A message to an active Codex worker
steers its in-flight turn through Codex app-server; an idle Codex or Claude Code
follow-up starts a new local background task. Neither path uses the Cloud
messaging backend.

An agent has a persistent identity and shared memory. It can have multiple
conversations, each with its own message history.

- Supply `conversation_id` to message an existing thread, or `agent_id` alone to
  start a new hidden thread with that agent. To use an agent's default conversation,
  supply its `agent_id` and `conversation_id: "default"`.
- Your agent and conversation IDs are attached automatically as the return address.
  To reply, the recipient must explicitly send to that address. Ordinary assistant
  output is not forwarded back to you.
- A successful send means Cloud accepted the message; the recipient may not have
  read it yet. Continue working rather than waiting for the answer.
- Omit `computer` unless a particular computer is needed. If the conversation is
  active on A, selecting B is rejected rather than moving the conversation.
- If delivery cannot be confirmed, check the recipient's messages before resending
  to avoid duplicates. The tool result includes details for inspecting the send.

Use Agent to launch or resume a managed Letta child task and receive its
completion notification. Letta-to-Letta sends create no local task ID. External
coding-agent follow-ups may return one when they start a new native turn; an
active Codex steer remains part of the existing task. SendAgentMessage does not
change the recipient's tools, model, or permissions. Load the messaging-agents
skill for additional CLI options and troubleshooting.
