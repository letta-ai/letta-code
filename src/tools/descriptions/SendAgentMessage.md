# SendAgentMessage

Send a message without waiting for its answer. Letta-to-Letta messages require
the Cloud backend and fail on the local backend (`agent-local-` IDs). Use this
to coordinate with an agent already working, including an Agent child, or to
contact any conversation you are authorized to access.

Claude Code and Codex workers return synthetic `claude_...` and `codex_...`
agent IDs backed by their native sessions. A message to active work steers its
in-flight turn (Claude interrupts through stream-json and sends the replacement
instruction; Codex uses app-server turn/steer). An idle follow-up starts one tracked local background
turn. Neither path uses the Cloud messaging backend.

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
- Keep sends sparse and useful: concise assignments, specific questions, or
  material updates. Skip status pings and repeated acknowledgments; repeat a
  point only when you have something new to add.
- For work already underway, treat the agent doing it as its owner. Send what it
  needs, then let it decide. Do not take over or redo its work. If you think
  ownership should change, ask the human instead of declaring it in a message.

Use Agent to launch or resume a managed Letta child task and receive its
completion notification. Letta-to-Letta sends create no local task ID. External
coding-agent follow-ups may return one when they start a new native turn; an
active external-agent steer remains part of the existing task. SendAgentMessage does not
change the recipient's tools, model, or permissions. Load the messaging-agents
skill for additional CLI options and troubleshooting.
