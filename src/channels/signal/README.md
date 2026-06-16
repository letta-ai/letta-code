# Signal channel

Letta's first-party Signal channel talks to an external
[`signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api)
daemon over JSON-RPC + server-sent events. Letta does **not** currently install,
register, link, or supervise `signal-cli`; setup configures Letta to connect to a
daemon you already run.

## Recommended setup

Use a dedicated Signal number for the agent. If you connect Letta to your
personal Signal account, self-message loop protection can ignore your own
messages and replies will be sent as that personal account.

1. Start `signal-cli-rest-api` in JSON-RPC mode. The interactive configure
   wizard can start this Docker container for you when Docker is available.

   Docker example:

   ```yaml
   services:
     signal-cli:
       image: bbernhard/signal-cli-rest-api:latest
       environment:
         MODE: json-rpc
       ports:
         - "8080:8080"
       volumes:
         - signal-cli-data:/home/.local/share/signal-cli
   ```

2. Register or link the Signal account in the daemon.

   Common paths:

   - QR/device link: use the daemon or `signal-cli link` flow, then scan the QR
     from Signal on your phone.
   - SMS registration: register a dedicated number, complete any
     `signalcaptchas.org` captcha, then verify the SMS code.

   Upstream references:

   - <https://github.com/AsamK/signal-cli>
   - <https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)>
   - <https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha>

3. Run Letta setup:

   ```bash
   letta channels configure signal
   ```

   The wizard first checks `http://127.0.0.1:8080`. If no daemon responds and
   Docker is installed, it can run the container command above automatically
   using the persistent volume `letta-signal-cli-data`.

4. Start Letta with Signal enabled:

   ```bash
   letta server --channels signal
   # or local backend:
   letta server --backend local --channels signal
   ```

5. Send the Signal account a DM. With `dm_policy: pairing` (recommended), Letta
   replies with a pairing code. In the target Letta conversation, run:

   ```text
   /channels signal pair <code>
   ```

## Config fields

Signal accounts live in `~/.letta/channels/signal/accounts.json`.

Important fields:

| Field | Description |
| --- | --- |
| `accountId` | Local Letta label for this Signal connection, e.g. `personal` or `bot`. This is not your Signal phone number. |
| `base_url` | `signal-cli-rest-api` JSON-RPC/SSE URL, usually `http://127.0.0.1:8080`. |
| `account` | Signal account phone number in E.164 format, e.g. `+15555550100`. |
| `account_uuid` | Optional Signal UUID for self-message filtering. |
| `agent_id` | Optional agent for account-bound DM/group auto-routing. |
| `dm_policy` | `pairing`, `allowlist`, or `open`. Pairing is recommended. |
| `group_mode` | `disabled`, `mention`, or `open`. Disabled is conservative. |
| `allowed_groups` | Optional group ID allowlist when groups are enabled. |
| `mention_patterns` | Text aliases/regexes used by mention-mode groups. |
| `download_media` | Download/surface inbound media. Defaults to `true` for new accounts. |
| `media_max_bytes` | Maximum inbound media bytes to consider. Default setup value is 25 MiB. |
| `transcribe_voice` | Auto-transcribe inbound audio when `OPENAI_API_KEY` is set. |

## Media and voice notes

Inbound images are copied into Letta channel storage and surfaced as both
attachment XML and image content parts so agents can inspect them. Other media,
including audio, is surfaced with `local_path` metadata in the message envelope.

Voice transcription uses the shared OpenAI transcription helper. Some Signal
voice notes arrive as raw `.aac`; OpenAI rejects raw AAC uploads, so Letta
converts unsupported audio to `.m4a` using `ffmpeg` before upload.

If `ffmpeg` is missing, the agent receives an
`<attempted_transcription_error>` in the message envelope telling you to install
`ffmpeg` on the listener machine.

## Troubleshooting

- **No inbound messages:** confirm the daemon is running with `MODE=json-rpc` and
  that Letta's `base_url` points at it.
- **Don't know what base URL to use:** run `letta channels configure signal` on
  the same machine as the listener and let it start/probe the local Docker
  daemon. Use a custom URL only when the daemon runs elsewhere.
- **Only placeholders like `[image attached]`:** confirm `download_media: true`,
  restart the listener after changing config, and check the daemon's attachment
  directory.
- **Voice transcription says unsupported audio or ffmpeg required:** install
  `ffmpeg` on the machine running `letta server`.
- **Pairing repeats:** approve the code in the target Letta conversation with
  `/channels signal pair <code>` or use the CLI pairing command.
- **Messages from yourself are ignored:** use a dedicated Signal number, or set
  `account_uuid` correctly so self-message filtering can distinguish identities.

## Current limitations

- Letta does not currently manage Signal registration/linking for you.
- The supported transport is `signal-cli-rest-api` JSON-RPC/SSE.
- Group support is intentionally conservative; start with `group_mode:
  disabled` or `mention` before using `open`.
