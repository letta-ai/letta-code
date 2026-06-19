# Discord channel

Use for Discord bot setup, guild/DM routing, allowed channels, threads, reactions, media, and privileged intents.

## Source files

- Plugin/runtime/setup: `src/channels/discord/plugin.ts`, `runtime.ts`, `setup.ts`.
- Account/config/routing gates: `account-config.ts`, `channel-gating.ts`, `debounce.ts`.
- Inbound/outbound/media/errors: `adapter.ts`, `message-actions.ts`, `media.ts`, `error-reply.ts`.
- High-signal tests: `src/channels/discord-service.test.ts`, `discord-registry.test.ts`, `discord-reconcile.test.ts`, `discord-channel-gating.test.ts`, `discord-adapter.test.ts`, `discord-media.test.ts`, `discord-error-reply.test.ts`, and Discord cases in `src/channels/message-channel.test.ts`.

## Setup

Create a Discord application and bot at <https://discord.com/developers>, then run:

```bash
./letta.js channels install discord
./letta.js channels configure discord
./letta.js server --channels discord
```

Recommended bot permissions: Send Messages, Read Message History, Add Reactions, Create Public Threads, Send Messages in Threads, Attach Files.

Enable Message Content privileged intent when the bot must read non-mention guild text, replies, or thread messages. Mention-only workflows may still need it depending on the interaction shape.

Important config fields:

- `token`: bot token; never print or commit.
- `agent_id`: account-bound routing target for DMs and guild mentions.
- `allowed_channels`: array or map of channel IDs to `open`/`mention-only`.
- `default_permission_mode`: `standard`, `acceptEdits`, or `unrestricted`.
- `auto_thread_on_mention`: create thread after mention.
- `thread_policy_by_channel`: per-channel thread behavior.
- `acknowledge_message_reaction`: sends acknowledgment reactions.
- `remove_stale_routes`: route reconciliation can remove disallowed channel routes when true.
- `inbound_debounce_ms`, `transcribe_voice`.

## Routing behavior

- DMs usually use pairing unless `dm_policy` is `open` or allowlisted.
- Guild mention mode creates/routes only explicit mentions or existing routed threads.
- Open guild mode should be restricted with `allowed_channels`; do not let a bot answer every channel accidentally.
- Thread routes have both parent channel and thread context; preserve `threadId` on replies.

## Common gotchas

- Discord reactions may be disabled by policy or missing permissions even when text works.
- Stale route reconciliation is deliberately conservative unless `remove_stale_routes` is true.
- A bot can be installed but unable to read/send in a channel due to Discord role/channel permissions.
- Do not broaden intents/permissions in the developer portal without user approval.
