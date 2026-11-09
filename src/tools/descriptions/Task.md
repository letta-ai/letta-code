# Agent

Launch an agent in the background. You'll be notified when it finishes; the user does not see its result unless you relay it.

A fresh agent knows only what you put in the prompt, and you see only the summary it sends back. Do the work yourself when it is a handful of tool calls or a lookup whose target you already know; delegate independent work that can run in parallel, or reading across many files where you only need the conclusion. Once you've delegated something, don't also run it yourself; wait for the result. Never fabricate or predict a pending agent's result: if the user asks before the notification arrives, say it's still running.

To steer an agent that is still working, call SendAgentMessage with the receipt's `Agent ID`, plus its `Conversation ID` when the receipt has one. For external harnesses, the Agent ID is the native session ID with a harness prefix (e.g. `claude_<session-id>`), and sending to it resumes that session. Do not call Agent again for the same task.

Progress and history:
- `Output file`: readable progress log.
- `Event log`: complete, untruncated JSONL record of tool calls, tool results, messages, and reasoning.
- Letta agents: `letta messages list --agent <agent_id> --conversation <conversation_id>` reads the full conversation, including later turns.
