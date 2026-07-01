# Telegram channel

Use for Telegram bot setup, routed Telegram replies, chat IDs, groups/topics, media/reactions, and rich/private message behavior.

## Source files

- Plugin/runtime/setup: `src/channels/telegram/plugin.ts`, `runtime.ts`, `setup.ts`.
- Account/config: `account-config.ts`.
- Inbound/outbound/media: `adapter.ts`, `message-actions.ts`, `media.ts`, `debounce.ts`.
- High-signal tests: `src/channels/telegram-account-config.test.ts`, `telegram-adapter.test.ts`, `telegram-registry.test.ts`, `telegram-live-smoke.test.ts`, and Telegram cases in `src/channels/message-channel.test.ts`.

## Setup

Create a bot with @BotFather and run:

```bash
./letta.js channels install telegram
./letta.js channels configure telegram
./letta.js server --channels telegram
```

The setup wizard validates the token with Telegram, then writes `~/.letta/channels/telegram/accounts.json` using secret storage when available.

Important config fields:

- `token`: bot token; never print or commit.
- `dm_policy`: `pairing`, `allowlist`, or `open`.
- `allowed_users`: Telegram user ID allowlist when enabled.
- `group_mode`: `open` or `mention-only`.
- `transcribe_voice`: voice memo transcription when `OPENAI_API_KEY` is set.
- `rich_private_chat_default`: private chats use rich delivery by default unless false.
- `rich_draft_streaming`: optional draft streaming.
- `inbound_debounce_ms`: group/topic debounce, capped at 10000 ms.

## Pairing and replies

For routed Telegram turns, use the incoming notification's `chat_id` and `accountId`. Do not assume `$TELEGRAM_CHAT_ID` is the right target for a routed reply.

Telegram external turns require `MessageChannel`; plain assistant final text is not delivered.

Use `send-rich` when the output benefits from rendered Markdown structure. Use `upload-file` for local media; do not try to embed local files in rich Markdown.

## Groups and topics

- Preserve topic/thread IDs from the notification when replying in groups/topics.
- Mention-only mode should route only explicit mentions or existing routed threads/topics.
- Debounce group/topic bursts if users send multi-message chunks.

## Common gotchas

- Global bot secrets may exist, but configured channel accounts live under `~/.letta/channels/telegram/`.
- Telegram `chat_id` can be numeric, negative for groups, or tied to a topic/thread context.
- Rich/private defaults can make normal `send` messages render through Bot API rich messages depending on account settings.
- SVG attachments should be uploaded as files, not inlined as images.
