# WhatsApp channel

Use for WhatsApp linked-device setup, QR scanning, self-chat mode, groups, media, and voice transcription.

## Source files

- Plugin/runtime/setup: `src/channels/whatsapp/plugin.ts`, `runtime.ts`, `setup.ts`.
- Account/session/state: `account-config.ts`, `session.ts`, `state.ts`, `jid.ts`.
- Inbound/outbound/media: `adapter.ts`, `message-actions.ts`, `media.ts`.
- High-signal tests: `src/channels/whatsapp-service.test.ts`, `whatsapp-protocol.test.ts`, `whatsapp-session.test.ts`, `whatsapp-jid.test.ts`, `whatsapp-adapter.test.ts`, `whatsapp-media.test.ts`, `whatsapp-message-channel.test.ts`.

## Setup

WhatsApp uses a linked-device runtime and QR login:

```bash
./letta.js channels install whatsapp
./letta.js channels configure whatsapp
./letta.js server --channels whatsapp
```

After starting the listener, scan the QR from WhatsApp: Settings → Linked Devices → Link a Device.

Important config fields:

- `agent_id`: optional account-bound routing target.
- `self_chat_mode`: talk to the agent by messaging yourself; recommended for personal numbers.
- `group_mode`: `disabled`, `mention`, or `open`.
- `allowed_groups`: group JID allowlist.
- `mention_patterns`: aliases or regexes for mention mode.
- `download_media`, `media_max_bytes`, `transcribe_voice`.

## Self-chat vs dedicated number

If using a personal WhatsApp number, prefer self-chat mode so the agent does not send ordinary messages as the user. If using a dedicated WhatsApp number for the agent, disable self-chat only after confirming the user understands replies will come from that number.

## Common gotchas

- QR login happens after the listener starts; configuration alone is not a complete login.
- Linked-device sessions can expire or be revoked from WhatsApp clients.
- Group JIDs and user JIDs are not always the same shape as phone numbers.
- Media download and transcription require runtime support and may fail independently from text delivery.
