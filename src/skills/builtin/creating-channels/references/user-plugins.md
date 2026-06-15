# Dynamic user channel plugins

## Layout

```text
~/.letta/channels/<id>/
  channel.json
  plugin.mjs
  accounts.json
  pairing.yaml
  routing.yaml
  runtime/
    package.json
    node_modules/
```

`channel.json`:

```json
{
  "id": "whatsapp-community",
  "displayName": "WhatsApp Community",
  "entry": "./plugin.mjs",
  "runtimePackages": ["some-sdk@1.0.0"],
  "runtimeModules": ["some-sdk"]
}
```

Rules:
- `id` must match the directory name.
- Do not use first-party ids (`telegram`, `slack`, `discord`). The registry skips them.
- `entry` is relative to the channel directory and must not escape it.
- `runtimePackages` install to `runtime/` via `letta channels install <id>`.
- User plugin bare imports usually need `~/.letta/channels/<id>/node_modules -> runtime/node_modules` symlink. Letta Code links this after installing user-plugin runtime dependencies.

## Account shape

User plugins should rely on `account.config`, not first-party fields.

```json
{
  "accounts": [
    {
      "channel": "whatsapp-community",
      "accountId": "main",
      "displayName": "WhatsApp Community",
      "enabled": true,
      "dmPolicy": "pairing",
      "allowedUsers": [],
      "config": {
        "token": "...",
        "phoneNumberId": "..."
      },
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Custom accounts have no generic `binding` field. Routing lives in `routing.yaml`, created by pairing, `letta channels route add`, or direct file management.

## Minimal plugin contract

`plugin.mjs` exports `channelPlugin` or `default`:

```js
export const channelPlugin = {
  metadata: {
    id: "whatsapp-community",
    displayName: "WhatsApp Community",
    runtimePackages: ["some-sdk@1.0.0"],
    runtimeModules: ["some-sdk"]
  },

  async createAdapter(account) {
    let onMessageHandler = null;
    let running = false;

    return {
      id: `whatsapp-community:${account.accountId}`,
      channelId: "whatsapp-community",
      accountId: account.accountId,
      name: account.displayName ?? "WhatsApp Community",
      async start() { running = true; },
      async stop() { running = false; },
      isRunning() { return running; },
      async sendMessage(msg) { return { messageId: crypto.randomUUID() }; },
      async sendDirectReply(chatId, text, options) {},
      get onMessage() { return onMessageHandler; },
      set onMessage(handler) { onMessageHandler = handler; }
    };
  },

  messageActions: {
    describeMessageTool() { return { actions: ["send"] }; },
    async handleAction({ adapter, request, formatText }) {
      if (request.action !== "send") return `Error: unsupported action ${request.action}`;
      const formatted = formatText(request.message ?? "");
      const result = await adapter.sendMessage({
        channel: request.channel,
        chatId: request.chatId,
        text: formatted.text,
        parseMode: formatted.parseMode,
        replyToMessageId: request.replyToMessageId,
        threadId: request.threadId
      });
      return `Message sent to ${request.channel} (message_id: ${result.messageId})`;
    }
  }
};
```

Inbound messages must call `adapter.onMessage(msg)` with:

```ts
{
  channel: string;
  accountId?: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  chatLabel?: string;
  text: string;
  timestamp: number;
  messageId?: string;
  threadId?: string | null;
  chatType?: "direct" | "channel";
  isMention?: boolean;
  raw?: unknown;
}
```

## Headless pairing

User plugins are headless. Pair from CLI:

```bash
letta channels pair \
  --channel <id> \
  --code <code> \
  --agent <agent-id> \
  --conversation <conversation-id>
```

Or route statically:

```bash
letta channels route add \
  --channel <id> \
  --chat-id <platform-chat-id> \
  --agent <agent-id> \
  --conversation <conversation-id>
```

`dmPolicy` behavior:
- `pairing`: unknown senders get a pairing code. Good for manual tests.
- `allowlist`: only `allowedUsers` sender IDs pass. Good for known headless users.
- `open`: everyone can reach routing lookup. Use with explicit routes or safe public channels.
