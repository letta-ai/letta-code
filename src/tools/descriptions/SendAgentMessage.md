Send a message to another agent's conversation without waiting for a reply: steer an agent you launched with Agent, ask a question, or hand off information. This continues an agent with its context intact; a new Agent call starts fresh.

- For an agent you launched, use the IDs in the Agent tool's result (or from ListAgents). Otherwise, `conversation_id` targets an existing conversation and `agent_id` alone starts a new conversation with that agent.
- Your return address is attached. The recipient replies only by sending back to it; its ordinary output does not reach you.
- An external worker that is mid-turn is steered within that turn; an idle one starts a new turn, and the result includes a `task_id`. You are notified when an agent you launched finishes; don't poll or send "are you done?" messages.
- As a subagent, omit both IDs to message your parent. Do so only when a parent decision would otherwise force you to redo work; state the default you will take and continue. Your final report already reaches the parent.
- Send assignments, specific questions, or material updates, not status pings. Don't take over work the recipient owns.
- Omit `computer` unless a particular computer is needed. If the conversation is active on one computer, selecting another is rejected rather than moving it.
- If delivery is unconfirmed, check the recipient's messages (`letta messages list --conversation <id>`) before resending.
