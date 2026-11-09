Send a message without waiting for its answer. Use this to coordinate with an agent already working, including an Agent child, or to contact any conversation you are authorized to access.

- For an agent you launched, including Claude Code and Codex workers, pass the receipt's `Conversation ID` as `conversation_id`. Use `agent_id` only to start a new conversation with an existing Letta agent (`conversation_id: null`), or with `conversation_id: "default"` to reach its default conversation. Pass full IDs; truncated IDs are rejected.
- Your return address is attached. The recipient replies only by sending back to it; its ordinary output does not reach you.
- Success means the message was accepted or delivery started, not that it was read. An external worker that is mid-turn is steered within that turn; an idle one starts a new turn, and the result includes a `task_id`. You are notified when an agent you launched finishes; don't poll or send "are you done?" messages.
- As a subagent, set `conversation_id` to null and omit `agent_id` to message your parent. Do so only when a parent decision would otherwise force you to redo work; state the default you will take and continue. Your final report already reaches the parent.
- Send assignments, specific questions, or material updates, not status pings. Don't take over work the recipient owns.
- Omit `computer` unless a particular computer is needed. If the conversation is active on one computer, selecting another is rejected rather than moving it.
- If delivery is unconfirmed, check the recipient's messages (`letta messages list --conversation <id>`) before resending.
