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

> Note: inbound channel delivery and user-visible replies are separate steps.
> A channel message can successfully reach the agent, but the agent still has to
> call `MessageChannel` to reply. If the transcript shows the incoming
> `<channel-notification>` but no `MessageChannel` tool call, this is usually a
> model/prompting issue rather than a channel adapter failure. For debugging,
> check whether the notification reached the conversation, whether the agent
> called `MessageChannel`, whether the tool result says the message was sent,
> and whether the route/account IDs match the original chat.

## Local backend channels

Channels can run against the experimental local backend without registering a
remote environment. In this mode the backend is in-process, so no
`LETTA_BASE_URL` is required.

```bash
letta channels install telegram
letta channels configure telegram
letta server --backend local --channels telegram
```

Then send the bot a message to get a pairing code and bind it to the local agent
and conversation:

```bash
letta channels pair \
  --channel telegram \
  --code XXXXXX \
  --agent <agent-id> \
  --conversation default
```

Only set `LETTA_BASE_URL` for a separate self-hosted server. For example,
`LETTA_BASE_URL=http://localhost:8283 letta server --channels telegram` talks to
a server running at that URL. Do not set a dummy `LETTA_BASE_URL` for
`--backend local`.

## Channel slash commands

Typed slash commands are handled before normal channel ingress so operational
commands do not get delivered to the agent as regular user messages. The shared
channel command set is:

- `/status` — show account, listener, route, agent, and conversation state.
- `/pause` — disable agent replies for the current routed chat.
- `/resume` — re-enable agent replies for the current routed chat.
- `/cancel` — abort the in-progress agent turn for the current routed chat.
- `/chat` — show the Letta web chat link for the current route.
- `/reflection` — start a memory reflection pass for the current route's agent
  conversation when MemFS is enabled.

Slack-native slash command payloads currently exist only for `/cancel`; the rest
are expected to be sent as normal channel messages in the relevant chat/thread.

## Slack app manifest notes

The bundled Slack channel runs in Socket Mode. The Slack app must still declare
the events, scopes, and slash commands that Slack should deliver to Letta Code.
For `/cancel`, add the `commands` bot scope and a native slash command entry:

```yaml
features:
  slash_commands:
    - command: /cancel
      url: https://example.com/slack/commands
      description: Cancel the in-progress Letta agent turn
      usage_hint: ""
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - commands
      - files:read
      - files:write
      - groups:history
      - im:history
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - reaction_added
      - reaction_removed
  socket_mode_enabled: true
```

Slack-native slash command payloads do not identify a thread. If `/cancel` is
sent through Slack's native command UI in a channel, Letta Code can target the
sole routed thread in that channel; if multiple Letta threads are routed there,
send `/cancel` as a normal thread message instead so the thread route is
unambiguous.

The slash command `url` is present because Slack manifests require one; the
Socket Mode listener receives the command over the app-level WebSocket.


## First-party vs user plugins

First-party plugins are bundled in `src/channels/<id>/` and registered by the
built-in registry. They can have bespoke Desktop UI and compatibility shims.

User plugins are discovered from `~/.letta/channels/<id>/channel.json`. They are
intentionally headless in this MVP. They should be configured by editing
`accounts.json` or by sending generic websocket/CLI account updates whose
plugin-owned fields live under `config` / `plugin_config`.

## WhatsApp account configuration

WhatsApp accounts are configured in
`~/.letta/channels/whatsapp/accounts.json`. All keys use `snake_case` in
storage and are normalized to `camelCase` at runtime.

### Standard fields

| Key | Default | Description |
|---|---|---|
| `agent_id` | `null` | Agent ID for DM and group auto-routing. |
| `self_chat_mode` | `true` | Reply under the linked user's identity. Set `false` to reply as the bot. |
| `group_mode` | `disabled` | Group ingestion: `disabled`, `mention`, `open`. |
| `allowed_groups` | `[]` | Group JIDs to allow when `group_mode` is not `open`. |
| `mention_patterns` | `[]` | Text aliases for group mention detection. |
| `transcribe_voice` | `false` | Auto-transcribe voice memos via OpenAI. |
| `download_media` | `false` | Download inbound media to local storage. |
| `media_max_bytes` | `52428800` | Max inbound media size (50 MB default). |

### Messaging fields

| Key | Default | Description |
|---|---|---|
| `message_prefix` | (none) | String prepended to outbound agent replies (e.g. an emoji for multi-agent identity). |
| `inbound_debounce_ms` | `0` | Batch rapid-fire messages into one agent turn. `0` = disabled. Range `0..10000`. Voice notes and attachments bypass. |
| `waiting_behavior` | `off` | UX feedback during agent turns: `off` (nothing), `typing_indicator` (typing dots), `message` (interim waiting message — reserved). |
| `waiting_message` | (none) | Custom text for `waiting_behavior: "message"`. |

### Audio fields

| Key | Default | Description |
|---|---|---|
| `audio_as_voice_memo` | `true` | When `true` (default), `.ogg`/`.oga`/`.opus` files are sent as voice memos (`ptt`). Set `false` to send all audio as documents. |

### Attachment policy fields

When `attachment_filter` is `true` (default), outbound media sends are
checked against three allowlists. All three must pass. When `false`,
policy checks are skipped and current behavior is preserved.

| Key | Default | Description |
|---|---|---|
| `attachment_filter` | `false` | Enable/disable attachment policy enforcement. When `false` (default), all media sends are allowed. |
| `attachment_mime_types` | `[]` | Allowed MIME types. `[]` denies all. `["*"]` allows all. Explicit entries are exact-match (e.g. `text/plain`, `application/pdf`). |
| `attachment_allowed_recipients` | `[]` | Allowed recipients (phone numbers or JIDs). `[]` denies all. `["*"]` allows all. Phone numbers work alongside JIDs. |
| `attachment_allowed_paths` | `[]` | Allowed source directories for files. Entries must be absolute paths to directories. `[]` denies all. |
| `attachment_path_recursive` | `false` | When `false`, files must be directly inside an allowed directory. When `true`, files in subdirectories are also allowed. Symlink escape is blocked. |

### Identity and LID discovery

WhatsApp is migrating from phone-number (PN) addressing to linked
identity (LID) addressing. The adapter handles this transparently:

- **LidDesk** learns PN↔LID mappings from inbound messages and the
  Baileys signal repository. Mappings persist to
  `~/.letta/channels/whatsapp/auth/<accountId>/lid-mappings.json` and
  survive container restarts.
- **On-demand lookup** via `sock.onWhatsApp(phone)` resolves LID for
  phone-only contacts that have never sent inbound. Rate-limited at 10
  lookups per phone per minute.
- **Route auto-bootstrap** creates routes for outbound sends to
  contacts with no prior inbound. Phone and LID chatIds are treated as
  aliases so a route created under one form is found when queried by
  the other.
- **Startup drain** migrates legacy phone-keyed routes to LID-keyed
  when the LidDesk knows the mapping.

Operators do not need to manually create parallel route entries (LID +
phone) in `routing.yaml`. The system handles this automatically.
