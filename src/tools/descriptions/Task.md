# Agent

Launch an agent in the background. You'll be notified when it finishes; the user does not see its result unless you relay it.

To steer an agent that is still working, use SendAgentMessage with the IDs from the launch receipt: the Conversation ID for a Letta agent (with its Agent ID when the conversation is `default`), or the Agent ID for an external worker. Do not call Agent again for the same task. If SendAgentMessage is unavailable, load the messaging-agents skill.

Progress and history:
- `Output file`: readable progress log.
- `Event log`: complete, untruncated JSONL record of tool calls, tool results, messages, and reasoning.
- Letta agents: `letta messages list --agent <agent_id> --conversation <conversation_id>` reads the full conversation, including later turns.
