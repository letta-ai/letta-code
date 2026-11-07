# Agent

Launch an agent in the background. You'll be notified when it finishes; the user does not see its result unless you relay it.

To steer an agent that is still working, call SendAgentMessage with the receipt's `Agent ID`, plus its `Conversation ID` when the receipt has one. For external harnesses, the Agent ID is the native session ID with a harness prefix (e.g. `claude_<session-id>`), and sending to it resumes that session. Do not call Agent again for the same task.

Progress and history:
- `Output file`: readable progress log.
- `Event log`: complete, untruncated JSONL record of tool calls, tool results, messages, and reasoning.
- Letta agents: `letta messages list --agent <agent_id> --conversation <conversation_id>` reads the full conversation, including later turns.
