# Telegram Channels MVP

Current setup flow:

1. Run `letta channels configure telegram`.
2. Start the listener with `letta server --channels telegram`.
3. Message the bot from Telegram once to receive a pairing code.
4. In the target ADE/Desktop conversation, run `/channels telegram pair <code>`.
5. Continue chatting with the agent from Telegram.

Persisted state lives under `~/.letta/channels/telegram/`:

- `config.yaml`: bot token, enabled flag, DM policy
- `pairing.yaml`: pending pairing codes and approved users
- `routing.yaml`: Telegram `chat_id` to Letta `agent_id` + `conversation_id` bindings

Notes:

- Channel config is machine-scoped, not agent-scoped.
- The recommended live management path is the `/channels ...` command from the target ADE/Desktop conversation.
- Standalone `letta channels route ...` and `letta channels pair ...` commands modify files on disk, but a running listener may not pick them up immediately.
