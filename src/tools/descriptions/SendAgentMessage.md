# SendAgentMessage

Send a message to another agent's conversation without waiting for a reply: steer an agent you launched with Agent, ask a question, or hand off information.

- For an agent you launched, use the IDs from its Agent receipt. Otherwise, `conversation_id` targets an existing thread and `agent_id` alone starts a new hidden thread.
- Your return address is attached. The recipient replies only by sending back to it; its ordinary output does not reach you. Keep working instead of waiting.
- As a subagent, omit both IDs to message your parent. Do so only when a parent decision would otherwise force you to redo work; state the default you will take and continue. Your final report already reaches the parent.
- Send assignments, specific questions, or material updates, not status pings. Don't take over work the recipient owns.
- If delivery is unconfirmed, check the recipient's messages before resending.

On the local backend (`agent-local-` IDs) or from a script, use the CLI instead; it waits and prints the reply as `result`:

```bash
letta -p --from-agent $LETTA_AGENT_ID --conversation <conversation-id> --output-format json "message"
```

Use `--agent <agent-id>` instead of `--conversation` for a new thread, and add `--backend local` after `letta` for `agent-local-` IDs. `letta messages list --conversation <id>` reads a thread.
