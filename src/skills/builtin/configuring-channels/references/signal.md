# Signal channel

Use for Signal setup, `signal-cli`, dedicated numbers, linked devices, profile/avatar changes, and Signal-specific send/receive issues.

## Source files

- Plugin/runtime/setup: `src/channels/signal/plugin.ts`, `runtime.ts`, `setup.ts`, `README.md`.
- Account/config/targeting: `account-config.ts`, `target.ts`, `client.ts`.
- Inbound/outbound: `adapter.ts`, `message-actions.ts`.
- High-signal tests: `src/channels/signal/setup.test.ts`, `adapter.test.ts`, `client.test.ts`, `target.test.ts`, plus `src/channels/signal-config.test.ts`, `signal-protocol.test.ts`, `signal-registry.test.ts`, `signal-service.test.ts`.

## Recommended runtime

First-party Signal support talks to a native `signal-cli daemon` or compatible JSON-RPC/SSE bridge at `/api/v1/check`, `/api/v1/rpc`, and `/api/v1/events`.

Prefer `signal-cli >= 0.14.5`. Version 0.13.23 can register but fail verification with opaque errors such as `StatusCode: 499`.

```bash
signal-cli --version
```

## Dedicated-number setup

Use one config directory consistently:

```bash
export SIGNAL_CLI_CONFIG="$HOME/.local/share/signal-cli-letta"
export SIGNAL_ACCOUNT="+15555550100"

signal-cli -c "$SIGNAL_CLI_CONFIG" -a "$SIGNAL_ACCOUNT" register
```

If Signal requires captcha, solve <https://signalcaptchas.org/registration/generate.html>, copy the `signalcaptcha://...` URL, and rerun registration with `--captcha`. Do not log or commit captcha URLs.

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" -a "$SIGNAL_ACCOUNT" register --captcha 'signalcaptcha://...'
signal-cli -c "$SIGNAL_CLI_CONFIG" -a "$SIGNAL_ACCOUNT" verify 123456
```

Registration can de-authenticate other sessions for that phone number. Prefer a dedicated number for bot-style accounts.

## Linked-device setup

For an existing Signal account:

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" link -n "Letta Code"
```

Scan the emitted `sgnl://linkdevice?...` QR/URI from Signal mobile: Settings → Linked Devices → +.

## Native daemon

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" daemon \
  --http 127.0.0.1:8080 \
  --receive-mode on-connection \
  --ignore-stories
```

Health checks:

```bash
curl -i --max-time 2 http://127.0.0.1:8080/api/v1/check
curl -i --max-time 2 -N http://127.0.0.1:8080/api/v1/events
```

Useful user systemd unit at `~/.config/systemd/user/signal-cli-letta.service`:

```ini
[Unit]
Description=Signal CLI daemon for Letta Code
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/signal-cli -c %h/.local/share/signal-cli-letta daemon --http 127.0.0.1:8080 --receive-mode on-connection --ignore-stories
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now signal-cli-letta.service
```

## Letta configuration

Run:

```bash
./letta.js channels configure signal
```

The wizard can use native `signal-cli` commands or `signal-cli-rest-api` setup endpoints when available. Native `signal-cli daemon` exposes runtime endpoints but not the wrapper `/v1/*` setup endpoints.

Signal account config lives in `~/.letta/channels/signal/accounts.json`.

Important fields:

- `accountId`: local Letta label, not phone number.
- `base_url`: usually `http://127.0.0.1:8080`.
- `account`: Signal E.164 number.
- `agent_id`: optional account-bound auto-routing agent.
- `self_chat_mode`: personal-number Note to Self mode.
- `dm_policy`: `pairing`, `allowlist`, or `open`.
- `group_mode`: `disabled`, `mention`, or `open`.
- `recipient_aliases`: map inbound UUIDs to replyable E.164 recipients when native Signal receives a UUID but outbound send needs a phone number.
- `download_media`, `media_max_bytes`, `transcribe_voice`: inbound media/voice behavior.

## Profile name/avatar

Update the Signal profile with:

```bash
signal-cli -c "$SIGNAL_CLI_CONFIG" -a "$SIGNAL_ACCOUNT" updateProfile \
  --given-name 'Co' \
  --about 'Letta agent' \
  --about-emoji '◯' \
  --avatar /path/to/avatar.jpg
```

If it waits on a config lock, stop the daemon, update the profile, then start the daemon again.

```bash
systemctl --user stop signal-cli-letta.service
signal-cli -c "$SIGNAL_CLI_CONFIG" -a "$SIGNAL_ACCOUNT" updateProfile --given-name 'Co' --avatar /path/to/avatar.jpg
systemctl --user start signal-cli-letta.service
```

Client UIs may take a refresh/sync before showing the new name or avatar.

## Signal gotchas

- Preserve `signal:` chat IDs when using `MessageChannel`.
- If direct `signal-cli send` works but JSON-RPC send fails, restart the daemon.
- If registration/linking fails while a daemon is running against the same config dir, stop the daemon and retry setup.
- Native setup-before-daemon is often simpler: register/link first, then start the daemon, then configure Letta.
- Signal formatting is body text plus body ranges, not Markdown.
