# Channel troubleshooting

Use this reference when a configured channel does not behave as expected. First classify the failure; do not start editing config at random. Random config edits are how integrations acquire folklore.

## Quick classification

1. **No listener**: service/process is not running, exits, or never starts the channel.
2. **No inbound**: platform messages do not produce `<channel-notification>` turns.
3. **Inbound works, outbound fails**: agent receives messages but `MessageChannel` send/react/upload fails.
4. **Pairing/route failure**: pairing code exists but route is missing, stale, disabled, or bound to the wrong agent/conversation.
5. **Wrong account/target**: replies go from the wrong bot/account or to the wrong chat/thread/topic.
6. **Media/reaction failure**: text works but upload, download, transcription, or reactions fail.
7. **Formatting failure**: message arrives but rich text, thread placement, quote/reply, or Markdown/body-ranges are wrong.

## Baseline checks

```bash
pwd
git status --short --branch
./letta.js --version
./letta.js channels status
./letta.js channels route list --channel <channel>
systemctl --user status letta-channels.service --no-pager
journalctl --user -u letta-channels.service -n 150 --no-pager
```

Confirm the listener service uses the checkout you are editing:

```bash
systemctl --user cat letta-channels.service
```

If a global `letta` command and `./letta.js` disagree, trust the executable used by the service.

## No listener or channel not started

Symptoms:

- `systemctl` inactive/failed.
- Logs show missing runtime module.
- `channels status` says runtime is not installed.
- Service `ExecStart` omits the channel.

Actions:

1. Run `./letta.js channels install <channel>` or rerun setup.
2. Ensure the service `ExecStart` includes the channel in `--channels`.
3. Run `systemctl --user daemon-reload` after unit edits.
4. Restart and re-check logs.
5. If runtime packages are installed under a packaged channel runtime, inspect `src/channels/<channel>/runtime.ts` and `src/channels/runtime-deps.ts`.

## No inbound

Symptoms:

- Platform message is visible in the external app but no `<channel-notification>` arrives.
- Listener is running and not obviously failing.

Actions:

1. Check platform-side permissions/intents/events/scopes.
2. Confirm the channel account is enabled in `accounts.json`.
3. Confirm DM/group/open/mention policy allows the incoming message.
4. Check route/pairing behavior: a first unpaired DM may only return pairing instructions.
5. Inspect channel adapter logs around inbound normalization.
6. For group/thread/topic channels, confirm the bot can see that venue and preserve topic/thread IDs.

Channel-specific likely causes:

- Telegram: bot privacy/group mode/topic mismatch.
- Discord: missing Message Content intent, role/channel permissions, or not mentioned in mention-only mode.
- Slack: missing Socket Mode, event subscription, or app not reinstalled after scopes changed.
- Signal: daemon not connected, wrong config dir, account not registered, or self-chat/group policy filters it.
- WhatsApp: QR linked-device session missing/expired, self-chat mode filtering other chats.

## Inbound works, outbound fails

Symptoms:

- Agent receives the message.
- `MessageChannel` send/react/upload errors or silently sends nowhere.

Actions:

1. Use the exact `channel`, `chat_id`, and `accountId` from the notification.
2. Preserve `threadId`, Telegram topic IDs, Discord thread IDs, and Slack thread context when present.
3. Check `message-actions.ts` for expected target shape.
4. Confirm outbound permissions/scopes include send/upload/react as needed.
5. Check cached targets in `targets.json` for proactive sends.
6. Restart the listener if config/routes changed outside the live UI/WS path.

Channel-specific likely causes:

- Signal: inbound sender is a UUID but outbound needs E.164; add `recipient_aliases` or use the replyable target.
- Telegram: local media must use `upload-file`; rich Markdown media blocks require HTTP/HTTPS URLs.
- Discord: bot lacks channel/thread send permissions or thread is archived/locked.
- Slack: file/reaction scopes missing; thread target missing.
- WhatsApp: linked session stale or JID shape mismatch.

## Pairing or route failure

Symptoms:

- Pairing code is consumed but messages still do not route.
- Route points at wrong agent/conversation.
- CLI says restart is required.

Actions:

```bash
./letta.js channels route list --channel <channel>
./letta.js channels status
```

1. Confirm the code was paired to the intended agent and conversation.
2. Confirm route is enabled and `outboundEnabled` is not false.
3. Restart the listener if pairing happened through CLI and the listener does not hot-reload the store.
4. For account-bound routing, confirm the account has the right `agent_id`/binding.
5. Remove or replace stale routes only after checking whether they are intentionally preserved.

## Wrong account or wrong target

Symptoms:

- Another bot/account replies.
- Reply appears in the wrong chat, thread, group, topic, or self-chat.

Actions:

1. Inspect `accounts.json` and route `accountId` values.
2. Always pass explicit `accountId` when replying from a routed turn.
3. Preserve `chat_id` exactly, including prefixes like `signal:`.
4. Inspect channel target resolution code and `targets.json` for proactive sends.
5. Check for duplicate accounts with overlapping permissions.

## Media, voice, reactions, and formatting

Text success does not imply media success.

- Media download/upload depends on channel runtime support, local file readability, size caps, and platform scopes.
- Voice transcription requires `OPENAI_API_KEY` and often `ffmpeg` or platform-specific audio conversion.
- Reactions require platform permissions/scopes and sometimes message IDs that encode author/timestamp.
- Rich formatting is channel-specific: Telegram has rich Markdown helpers; Signal uses body text/bodyRanges; Discord and Slack have their own markdown-ish rules.

Inspect `media.ts`, `message-actions.ts`, and `message-channel.test.ts` before changing behavior.

## When to restart

Restart after:

- systemd unit edits;
- changing `--channels` list;
- manual edits to `accounts.json`, `routing.yaml`, `targets.json`, or `pairing.yaml`;
- Signal account registration/link/profile updates that require stopping the daemon;
- runtime dependency installation;
- stale config symptoms after a CLI operation.

Do not restart blindly in the middle of interactive linking/registration unless the external tool is wedged.

## What to update after debugging

- Update a channel README when a human needs setup instructions.
- Update this skill when an agent needs a reusable diagnostic or operational pattern.
- Update source/tests when behavior is wrong or the setup wizard can prevent the failure.
