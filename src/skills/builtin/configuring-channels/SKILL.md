---
name: configuring-channels
description: Configures and debugs Letta Code messaging channels such as Telegram, Signal, Discord, Slack, WhatsApp, and custom channels. Use when setting up `letta channels`, pairing chats, installing channel runtimes, editing channel account/routing config, running channel listeners, configuring Signal via signal-cli, diagnosing inbound/outbound MessageChannel delivery, or managing systemd channel services.
---

# Configuring Channels

Use this skill for Letta Code channel setup and debugging.

Core rule: generated assistant text is not delivered to external users. When handling a routed external channel turn, reply through `MessageChannel` with the routed `channel`, `chat_id`, and `accountId` unless no user-visible reply is appropriate.

## Load the right reference

Start with [operations.md](references/operations.md) for common preflight, account config, routing, pairing, listener/systemd, and smoke-test procedures. Load [troubleshooting.md](references/troubleshooting.md) when something is broken or ambiguous.

Load channel-specific references only when relevant:

- [signal.md](references/signal.md) — Signal, signal-cli, native daemon, captcha/verification, profile/avatar, recipient aliases.
- [telegram.md](references/telegram.md) — Telegram bots, BotFather tokens, chat IDs, rich messages, groups/topics, routed replies.
- [discord.md](references/discord.md) — Discord bots, privileged intents, guild modes, allowed channels, threads, reactions.
- [slack.md](references/slack.md) — Slack Socket Mode, xoxb/xapp tokens, scopes/events, slash command, reactions/files.
- [whatsapp.md](references/whatsapp.md) — WhatsApp linked-device QR, self-chat vs dedicated number, groups/media/voice.
- [custom.md](references/custom.md) — custom channel config, arbitrary account JSON, scaffolding new first-party or local integrations.

If the user asks about an unlisted channel, inspect `src/channels/<channel>/plugin.ts`, `setup.ts`, `account-config.ts`, and tests before editing config or docs.

## Fast workflow

1. Identify the canonical Letta Code checkout and version.
2. Inspect `./letta.js channels status` and existing routes before changing anything.
3. Install/configure the channel runtime through `./letta.js channels install <channel>` and `./letta.js channels configure <channel>` when possible.
4. For long-running listeners, update the service channel list and restart `letta-channels.service` after config, route, or account changes that were not made through a live WS/UI path.
5. Pair the chat to the target agent/conversation, then list routes to confirm.
6. Smoke-test both directions: platform → `<channel-notification>` and `MessageChannel` → platform.
7. Record reusable gotchas in the relevant reference or channel README when setup required non-obvious recovery. Human setup instructions belong in channel READMEs; agent operation/diagnosis patterns belong in this skill.

## Safety rules

- Do not print tokens, app passwords, Signal captcha URLs, raw private message bodies, or verification codes in durable logs or docs.
- Prefer dedicated bot/agent accounts or numbers over personal accounts unless the user explicitly wants self-chat mode.
- Preserve channel-specific chat target formats, especially `signal:` prefixes, Slack thread targets, Discord thread IDs, and Telegram topic/thread IDs.
- Do not commit channel config, local account files, downloaded media, or secrets.
- Do not commit repo changes unless the user explicitly asks.
