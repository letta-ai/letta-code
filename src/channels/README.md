# Channel plugins

Letta Code channels connect agents to external chat systems. Telegram, Slack,
and Discord are first-party bundled plugins with custom Desktop UI. User-defined
plugins are loaded from `~/.letta/channels/<channel-id>/` and run headlessly:
they can receive inbound messages, participate in pairing/routing, and extend
the shared `MessageChannel` tool, but they do not get custom Desktop screens.

## Directory layout

```text
~/.letta/channels/
  whatsapp/
    channel.json
    plugin.mjs
    accounts.json
    routing.yaml
    pairing.yaml
    runtime/
      package.json
      node_modules/
```

`channel.json` registers the plugin:

```json
{
  "id": "whatsapp",
  "displayName": "WhatsApp",
  "entry": "./plugin.mjs",
  "runtimePackages": ["@whiskeysockets/baileys@6.7.18"],
  "runtimeModules": ["@whiskeysockets/baileys"]
}
```

Rules:

- `id` must match the directory name and use lowercase letters, numbers,
  `_`, or `-`.
- `entry` is resolved relative to the channel directory.
- `runtimePackages` are installed into `runtime/` by
  `letta channels install <id>`.
- `runtimeModules` are resolved from bundled first-party runtimes first, then
  from the user channel `runtime/` directory.

## Plugin entry

`plugin.mjs` exports either `channelPlugin` or `default`:

```js
export const channelPlugin = {
  metadata: {
    id: "whatsapp",
    displayName: "WhatsApp",
    runtimePackages: ["@whiskeysockets/baileys@6.7.18"],
    runtimeModules: ["@whiskeysockets/baileys"]
  },

  async createAdapter(account) {
    return {
      id: `whatsapp:${account.accountId}`,
      channelId: "whatsapp",
      accountId: account.accountId,
      name: account.displayName ?? "WhatsApp",
      async start() {},
      async stop() {},
      isRunning() { return false; },
      async sendMessage(message) { return { messageId: crypto.randomUUID() }; },
      async sendDirectReply(chatId, text) {},
      onMessage: undefined
    };
  },

  messageActions: {
    describeMessageTool() {
      return { actions: ["send"] };
    },
    async handleAction({ adapter, request, formatText }) {
      const formatted = formatText(request.message ?? "");
      const result = await adapter.sendMessage({
        channel: request.channel,
        chatId: request.chatId,
        text: formatted.text,
        parseMode: formatted.parseMode,
        threadId: request.threadId
      });
      return `Message sent to ${request.channel} (message_id: ${result.messageId})`;
    }
  }
};
```

## Account model

All channels share the same persisted account envelope:

```ts
type ChannelAccount = {
  channel: string;
  accountId: string;
  displayName?: string;
  enabled: boolean;
  dmPolicy: "pairing" | "allowlist" | "open";
  allowedUsers: string[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

The `config` object is plugin-owned and may contain secrets. In the custom
plugin MVP, Desktop/websocket responses do not echo this object back; they only
include a generic redacted config summary. First-party bundled plugins can keep
custom redaction/compatibility adapters because they also have bespoke Desktop
UI.

First-party bundled plugins may keep compatibility with their older account
fields internally, but user plugins should only rely on `account.config`.

## Runtime behavior

The MVP runtime path supports custom plugins that fit the generic pairing and
routing flow:

1. The adapter receives an inbound message and calls `adapter.onMessage(msg)`.
2. Letta Code enforces `dmPolicy` / `allowedUsers`.
3. Letta Code resolves a route from `routing.yaml` or creates a pairing code.
4. The routed message is delivered to the bound agent/conversation.
5. `MessageChannel` becomes available when the conversation has an active route
   for at least one running channel adapter.

Plugins that need Slack/Discord-style auto-routing or rich Desktop management
remain first-party/bundled work for now. Custom plugins can still expose custom
`MessageChannel` actions and schema fragments via `messageActions`.

## First-party vs user plugins

First-party plugins are bundled in `src/channels/<id>/` and registered by the
built-in registry. They can have bespoke Desktop UI and compatibility shims.

User plugins are discovered from `~/.letta/channels/<id>/channel.json`. They are
intentionally headless in this MVP. They should be configured by editing
`accounts.json` or by sending generic websocket/CLI account updates whose
plugin-owned fields live under `config` / `plugin_config`.
