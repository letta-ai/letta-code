# Channel testing checklist

## Basic commands

From the relevant `letta-code` worktree:

```bash
bun install
bun dev channels status
bun dev channels install <channel>
bun dev server --channels <channel> --debug
```

For self-hosted/local desktop envs, `LETTA_BASE_URL` may point at `http://localhost:<port>`, causing the listener to skip Cloud environment registration. That is fine for local testing if the target agent exists on that local server.

## User plugin smoke test

1. Create `~/.letta/channels/<id>/channel.json`, `plugin.mjs`, and `accounts.json`.
2. Install runtime deps:

   ```bash
   bun dev channels install <id>
   ```

3. Start listener:

   ```bash
   bun dev server --channels <id> --debug
   ```

4. Confirm plugin-specific startup log appears. If import fails, check `runtime/node_modules` and the user plugin `node_modules` symlink.
5. Send a platform message.
6. If pairing is enabled, redeem the code:

   ```bash
   bun dev channels pair --channel <id> --code <code> --agent <agent-id> --conversation <conversation-id>
   ```

7. Send another platform message. The conversation should receive a `<channel-notification>`.
8. Reply with `MessageChannel` using the channel id and `chat_id` from the notification.

## Verification

Run targeted tests first, then broad checks:

```bash
bun test src/tests/channels/<channel-or-area>.test.ts
bun run typecheck
bun run lint
bun run build
```

`letta-code` uses `bun:test`, not a package `test` script.

## Debugging symptoms

- **Plugin not discovered**: id mismatch between directory and `channel.json`, invalid id chars, or id shadows first-party channel.
- **Install says already installed but imports fail**: runtime resolver counted dev `node_modules`; ensure runtime deps actually exist under `~/.letta/channels/<id>/runtime/node_modules` and symlink `~/.letta/channels/<id>/node_modules` to it.
- **Inbound receives pairing code forever**: pairing was not redeemed for the same `accountId`/`senderId`, or listener cannot reload `pairing.yaml`.
- **Inbound reaches agent but replies no-op**: missing `plugin.messageActions` or route lookup mismatch in `MessageChannel` args.
- **Route lookup misses**: wrong `chatId`, wrong `accountId`, or unstable `threadId` choice.
- **Cron lease error**: usually unrelated to channel runtime; another Letta Code process owns scheduler lease.
