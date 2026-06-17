# Signal channel

Letta's first-party Signal channel talks to an external Signal bridge over
JSON-RPC + server-sent events. The recommended runtime is native `signal-cli
daemon` (`/api/v1/check`, `/api/v1/rpc`, `/api/v1/events`). The configure
wizard can also use native `signal-cli` commands for account linking and SMS /
voice registration, or use
[`signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api)
setup endpoints (`/v1/*`) when that wrapper is available.

## TL;DR

Start a local native daemon, configure the account, then run Letta with Signal:

```bash
signal-cli -c ~/.local/share/signal-cli-letta daemon \
  --http 127.0.0.1:8080 \
  --receive-mode on-connection \
  --ignore-stories

letta channels configure signal
letta server --channels signal
```

Use a dedicated Signal number when possible. If you use your personal number,
enable `self_chat_mode` and talk to the agent through Signal's Note to Self /
self-chat.

## Recommended setup

Use a dedicated Signal number for the agent when you want it to participate in
ordinary DMs/groups. If you connect Letta to your personal Signal account,
enable `self_chat_mode` and talk to it through Signal's Note to Self/self-chat;
that mode only permits messages to/from the linked account itself.

1. Start a Signal bridge. Native `signal-cli daemon` is the first-party runtime
   path:

   ```bash
   signal-cli -c ~/.local/share/signal-cli-letta daemon \
     --http 127.0.0.1:8080 \
     --receive-mode on-connection \
     --ignore-stories
   ```

   Alternative: start `signal-cli-rest-api` in JSON-RPC mode. The interactive
   configure wizard can start this Docker container for you when Docker is
   available.

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

2. Register or link the Signal account in the daemon/config directory.

   `letta channels configure signal` can help with this after it starts/probes
   the daemon:

   - It lists already-linked accounts from `/v1/accounts` when available.
   - It can open the `/v1/qrcodelink` QR page for device linking.
   - It can request SMS/voice registration with `/v1/register/{number}` and
     verify the code with `/v1/register/{number}/verify/{code}`.
   - If Signal requires captcha, it points you at `signalcaptchas.org` and asks
     for the returned `signalcaptcha://...` URL.
   - Native `signal-cli daemon` exposes only Letta's runtime JSON-RPC paths
     (`/api/v1/*`) and not wrapper setup REST paths (`/v1/*`). In that case the
     wizard uses local native `signal-cli` commands when available.
   - Native link renders the emitted `sgnl://linkdevice?...` URI as an ASCII QR
     in the terminal and parses the final `Associated with: +...` account.
   - If native link reports the account already exists in the config directory,
     the wizard offers to use that existing linked account or cancels with the
     delete-path recovery instruction.

   Common paths:

   - QR/device link: use the daemon `/v1/qrcodelink` flow when available, or
     native `signal-cli link -n "Letta Code"` with the wizard-rendered QR.
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
   using the persistent volume `letta-signal-cli-data`. If a native daemon is
   already running, it detects the daemon's config directory and can run native
   setup commands against that directory.

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

## Manual native `signal-cli` setup

If you do not want to rely on the interactive wizard for Signal account setup,
you can run native `signal-cli` directly. Use the same config directory for all
commands and for the daemon.

```bash
export SIGNAL_CLI_CONFIG="$HOME/.local/share/signal-cli-letta"
export SIGNAL_ACCOUNT="+15555550100"
```

### Option A: link an existing Signal account/device

Run the link command:

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" link -n "Letta Code"
```

`signal-cli` prints an `sgnl://linkdevice?...` URI. Scan it from Signal mobile:

1. Open Signal on your phone.
2. Go to **Settings → Linked Devices**.
3. Tap **+**.
4. Scan the QR/URI shown by `signal-cli`.

When linking succeeds, `signal-cli` prints an associated phone number. Use that
number as the Signal account in `letta channels configure signal`.

If `signal-cli` says the user already exists in the config directory, you can
reuse that account or remove the account directory it reports and link again.

### Option B: register a dedicated Signal number

Register the number:

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" -a "$SIGNAL_ACCOUNT" register
```

If Signal requires a captcha, open:

```text
https://signalcaptchas.org/registration/generate.html
```

Complete the captcha and copy the returned `signalcaptcha://...` URL, then run:

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" -a "$SIGNAL_ACCOUNT" register \
  --captcha 'signalcaptcha://...'
```

After you receive the SMS/voice verification code, verify it:

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" -a "$SIGNAL_ACCOUNT" verify 123456
```

Registration can de-authenticate other Signal sessions for that phone number,
so prefer a dedicated number for bot-style accounts.

### Start the native daemon

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" daemon \
  --http 127.0.0.1:8080 \
  --receive-mode on-connection \
  --ignore-stories
```

Keep the daemon running while Letta is running.

### Smoke-test the daemon

Health check:

```bash
curl -i --max-time 2 http://127.0.0.1:8080/api/v1/check
```

Event stream check. A timeout is okay as long as headers show HTTP 200 and
`text/event-stream`:

```bash
curl -i --max-time 2 -N http://127.0.0.1:8080/api/v1/events
```

Optional JSON-RPC send smoke test:

```bash
curl -sS http://127.0.0.1:8080/api/v1/rpc \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "method": "send",
    "params": {
      "account": "+15555550100",
      "recipient": ["+15555550123"],
      "message": "Signal daemon smoke test"
    },
    "id": "smoke-test"
  }'
```

If direct `signal-cli send` works but JSON-RPC `send` fails, restart the daemon.
Stale native daemon processes can receive events while JSON-RPC sends fail after
account/config changes.

Then run:

```bash
letta channels configure signal
letta server --channels signal
```

## Config fields

Signal accounts live in `~/.letta/channels/signal/accounts.json`.

Important fields:

| Field | Description |
| --- | --- |
| `accountId` | Local Letta label for this Signal connection, e.g. `personal` or `bot`. This is not your Signal phone number. |
| `base_url` | Signal JSON-RPC/SSE bridge URL, usually `http://127.0.0.1:8080`. |
| `account` | Signal account phone number in E.164 format, e.g. `+15555550100`. |
| `account_uuid` | Optional advanced loop-protection identity. Only needed when the daemon reports the linked account's own messages as a UUID instead of the configured phone number. |
| `agent_id` | Optional agent for account-bound DM/group auto-routing. |
| `self_chat_mode` | Personal-number mode. When true, Letta routes only the linked account's own Note to Self/self-chat messages and ignores other DMs on that Signal account. |
| `dm_policy` | `pairing`, `allowlist`, or `open`. Pairing is recommended. |
| `group_mode` | `disabled`, `mention`, or `open`. Disabled is conservative. |
| `allowed_groups` | Optional group ID allowlist when groups are enabled. |
| `mention_patterns` | Text aliases/substrings used by mention-mode groups. |
| `recipient_aliases` | Optional map from inbound sender identities to replyable recipients, e.g. Signal UUID to E.164 phone number. Useful when native `signal-cli` receives from a UUID but can only send replies to the phone number. |
| `download_media` | Download/surface inbound media. Defaults to `true` for new accounts. |
| `media_max_bytes` | Maximum inbound media bytes to consider. Default setup value is 25 MiB. |
| `transcribe_voice` | Auto-transcribe inbound audio when `OPENAI_API_KEY` is set. |

## Personal-number / self-chat safety model

`self_chat_mode` is for using your personal Signal number without letting Letta
read or send ordinary Signal DMs from that account.

When `self_chat_mode: true`:

- Inbound messages route only when they are from the linked account itself,
  including native `syncMessage.sentMessage` Note to Self events.
- Non-self direct messages are dropped before routing.
- Outbound sends/reactions are rejected unless the target is the linked account
  itself.
- Groups are not a self-chat target; self-chat mode is intended for Note to Self
  only.

Only one enabled Signal account may use a given `base_url`. Native
`signal-cli` event streams are daemon-scoped; if you want multiple Signal
accounts enabled at once, run separate `signal-cli daemon` instances with
separate config directories and ports, then give each Letta account a distinct
`base_url`.

When `self_chat_mode: false`:

- Messages from the linked account itself are treated as loop-protection echoes
  and ignored.
- DMs/groups follow the normal `dm_policy`, allowlist, pairing, and
  `group_mode` settings.

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

- **No inbound messages:** confirm the native daemon is listening on
  `/api/v1/events` or the wrapper is running in JSON-RPC mode, and that Letta's
  `base_url` points at it.
- **Don't know what base URL to use:** run `letta channels configure signal` on
  the same machine as the listener and let it start/probe the local Docker
  daemon. Use a custom URL only when the daemon runs elsewhere.
- **No account listed by the daemon:** use the configure wizard's QR link flow
  or SMS/voice registration flow, then rerun account detection.
- **QR page says 404:** your daemon exposes runtime JSON-RPC but not `/v1/*`
  wrapper setup endpoints. Use the native setup path in
  `letta channels configure signal`; it renders the `signal-cli link` URI as a
  QR when possible.
- **Captcha required:** the wizard opens `signalcaptchas.org`, asks for the
  returned `signalcaptcha://...` URL, and runs native
  `signal-cli register --captcha` or the wrapper `/v1/register` equivalent.
- **Only placeholders like `[image attached]`:** confirm `download_media: true`,
  restart the listener after changing config, and check the daemon's attachment
  directory.
- **Voice transcription says unsupported audio or ffmpeg required:** install
  `ffmpeg` on the machine running `letta server`.
- **Pairing repeats:** approve the code in the target Letta conversation with
  `/channels signal pair <code>` or use the CLI pairing command.
- **Messages from yourself are ignored / bot seems to ignore own linked-device messages:** this is loop protection in normal mode. Enable `self_chat_mode` only when you intentionally want Note to Self/self-chat routing.
- **Using your personal Signal number:** enable `self_chat_mode` and talk to the agent in Signal's Note to Self/self-chat. Other direct messages on that linked account are ignored, and outbound sends to non-self targets are rejected while self-chat mode is enabled.
- **Agent receives messages but replies fail with internal server error:** check whether the inbound `chat_id` is a UUID like `signal:accd...`. If native `signal-cli` cannot send to that UUID, add a `recipient_aliases` mapping from the UUID to the replyable phone number, then restart the listener.

## Current limitations

- Letta does not install or supervise `signal-cli`; you still need a running
  native daemon or compatible wrapper.
- Runtime support targets native `signal-cli` JSON-RPC/SSE. Wrapper `/v1/*`
  endpoints are used only for setup when available.
- Group support is intentionally conservative; start with `group_mode:
  disabled` or `mention` before using `open`.
