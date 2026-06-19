# Channel operations

Use this reference for common channel setup and debugging before loading a channel-specific reference.

## Source of truth

- Channel source code: `src/channels/<channel>/`.
- Built-in channel plugins: `src/channels/<channel>/plugin.ts`.
- Setup wizard: `src/channels/<channel>/setup.ts`.
- Account config validation: `src/channels/<channel>/account-config.ts`.
- User config root: `~/.letta/channels/<channel>/`.
- Common files: `accounts.json`, `routing.yaml`, `pairing.yaml`, `targets.json`.
- Bundled built-in skills source: `src/skills/builtin/`.

## Preflight

```bash
pwd
git status --short --branch
./letta.js --version
./letta.js channels status
./letta.js channels route list --channel <channel>
```

For packaged/root installs, confirm which executable the service uses. A global `letta` wrapper may not be the same checkout as `./letta.js`.

## Configure and run

```bash
./letta.js channels install <channel>
./letta.js channels configure <channel>
./letta.js server --channels <channel>
```

For a multi-channel service:

```bash
systemctl --user cat letta-channels.service
systemctl --user status letta-channels.service --no-pager
journalctl --user -u letta-channels.service -n 100 --no-pager
```

If channels run under systemd and the channel set changes, update `ExecStart`, then run:

```bash
systemctl --user daemon-reload
systemctl --user restart letta-channels.service
```

## Pairing and routes

Pair a code to a specific agent/conversation:

```bash
./letta.js channels pair \
  --channel <channel> \
  --code <PAIRING_CODE> \
  --agent <agent-id> \
  --conversation <conversation-id>
```

Then verify:

```bash
./letta.js channels route list --channel <channel>
./letta.js channels status
```

If the CLI reports that a listener restart is needed, restart the listener. Pairing through live UI/WS paths may not require restart.

## Smoke test

A real channel setup is not complete until both paths work:

1. Send a normal platform message and confirm the agent receives a `<channel-notification>`.
2. Send a user-visible reply with `MessageChannel`, using the notification's `channel`, `chat_id`, and `accountId`.
3. Confirm the platform displays the reply.
4. If supported, test media upload/download and reactions separately.

Plain assistant final text is only local to Letta Code; it is not sent to Telegram/Signal/Discord/etc.

## Common failure modes

- Wrong checkout: systemd runs a different `letta.js` or global `letta` than the repo being edited.
- Runtime missing: `channels status` shows not installed; run `channels install` or the setup wizard.
- Listener stale: config or routes changed while the listener process is still holding old state.
- Secrets unavailable: service lacks env files or secret backend access.
- Account mismatch: outbound `accountId` is omitted or picks a different configured account.
- Target shape mismatch: thread IDs, topic IDs, Signal UUIDs, Slack cached targets, or Discord thread routes are missing.
- Local files leaked: inbound attachments/config files should be inspected locally but not committed.

## Documentation updates

Add durable lessons when setup exposed non-obvious recovery:

- minimum supported external tool versions;
- restart/reload requirements;
- systemd units or service env files;
- exact account config fields;
- pairing route caveats;
- profile/avatar setup;
- platform-specific delivery semantics;
- privacy or secret-handling hazards.
