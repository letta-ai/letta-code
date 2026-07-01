# Slack channel

Use for Slack Socket Mode setup, xoxb/xapp tokens, app events, scopes, slash commands, reactions, files, and Slack thread routing.

## Source files

- Plugin/runtime/setup: `src/channels/slack/plugin.ts`, `runtime.ts`, `setup.ts`.
- Account/config: `account-config.ts`.
- Inbound/outbound/targets/media: `adapter.ts`, `message-actions.ts`, `target-resolution.ts`, `proactive-accounts.ts`, `media.ts`, `web-api-client.ts`.
- High-signal tests: `src/channels/slack/adapter.test.ts`, `slack-adapter.test.ts`, `slack-registry.test.ts`, `slack-target-resolution.test.ts`, `slack-media.test.ts`, and Slack cases in `src/channels/message-channel.test.ts`.

## Setup

Slack uses Socket Mode with both a bot token and an app token:

```bash
./letta.js channels install slack
./letta.js channels configure slack
./letta.js server --channels slack
```

Recommended setup:

- Create a Slack app for the workspace.
- Enable Socket Mode and create an `xapp-...` app token.
- Install the app to get an `xoxb-...` bot token.
- Enable App Home messages.
- Subscribe to `app_mention`, `message.channels`, `message.groups`, `message.im`, `reaction_added`, and `reaction_removed` as needed.
- Add `/cancel` if Slack-native cancellation is desired.

Recommended bot scopes include `app_mentions:read`, `channels:history`, `chat:write`, `commands`, `groups:history`, `im:history`, `users:read`, `reactions:read`, `reactions:write`, `files:read`, and `files:write`.

Important config fields:

- `bot_token`: `xoxb-...`; never print or commit.
- `app_token`: `xapp-...`; never print or commit.
- `mode`: currently `socket`.
- `agent_id`: account-bound routing target.
- `default_permission_mode`: tool permission behavior for Slack-originated turns.
- `transcribe_voice`, `show_completed_reaction`, `listen_mode`.

## Routing behavior

- Slack DMs are often `open` by default, but allowlist can be used for private workspaces.
- Preserve Slack thread context for replies. A channel route may still need an active thread target.
- For proactive sends, prefer explicit cached targets when supported rather than guessing from a channel name.

## Common gotchas

- Bot token and app token are both required for Socket Mode.
- Missing event subscriptions can make the app appear online but not receive messages.
- File upload/reaction support depends on scopes.
- Workspace app installation must be refreshed after adding scopes/events.
