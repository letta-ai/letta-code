# First-party Letta Code channels

Use first-party channel work when the channel needs Desktop UI, rich snapshots, compatibility shims, or bespoke routing.

## File cascade

Adding a channel usually touches:

- `src/channels/types.ts` — account/config types, channel id union.
- `src/channels/pluginRegistry.ts` — metadata and dynamic import.
- `src/channels/<channel>/plugin.ts` — `ChannelPlugin` export.
- `src/channels/<channel>/adapter.ts` — start/stop/inbound/send behavior.
- `src/channels/<channel>/messageActions.ts` — `MessageChannel` action surface.
- `src/channels/<channel>/setup.ts` — CLI setup wizard if needed.
- `src/channels/<channel>/runtime.ts` — runtime dependency helper if needed.
- `src/channels/accounts.ts` — legacy/default account clone handling.
- `src/channels/service.ts` — snapshots, create/update payloads.
- `src/websocket/listener/client.ts` — snapshot serialization/mapping.
- `src/types/protocol_v2.ts` — wire protocol account snapshots and create/update payloads.
- `src/channels/registry.ts` — only if routing differs from generic pairing/route flow.
- `src/channels/xml.ts` — channel-specific message formatting hints.
- `src/tests/channels/*.test.ts` — targeted unit coverage.

Adding a per-channel field cascades through account/config types, service snapshots, accounts clone/defaults, protocol v2, websocket mapping, adapter behavior, and tests.

## Required plugin shape

Every reply-capable channel plugin must expose `messageActions`:

```ts
export const myChannelPlugin: ChannelPlugin = {
  metadata: { id: "my-channel", displayName: "My Channel", runtimePackages: [], runtimeModules: [] },
  createAdapter(account) { return createMyAdapter(account as MyChannelAccount); },
  runSetup() { return runMySetup(); },
  messageActions: myMessageActions,
};
```

Without `messageActions`, the shared `MessageChannel` tool returns `Channel "X" does not expose MessageChannel actions.` as a tool-result string. Agents often absorb that silently, making the channel look like it no-opped.

Use `src/channels/telegram/messageActions.ts` as the canonical simple implementation.

## Routing choices

- Generic pairing route: unknown direct senders receive a pairing code, `routing.yaml` maps chat → agent/conversation.
- Slack/Discord-style auto-routing: channel account has an agent binding; registry creates conversations automatically for DMs/threads.
- Threaded channels: choose stable route keys carefully. `chatId` should usually be the stable conversation/root id; `threadId` should only vary when routes should split.

## Public-channel safety

Public posting channels must not relay tool approval/control prompts by default. Implement `handleControlRequestEvent` as a no-op or verified-operator path. Otherwise `sendDirectReply` fallback can publicly post tool name, command args, working directory, and an `approve` instruction.

## Bluesky lessons

- Do not use pagination cursor presence as a “has polled before” flag. Bluesky may omit cursors when there is no next page. Use a dedicated `hasCompletedInitialPoll` boolean.
- App passwords cannot read/send DMs; Bluesky V1 only supports public notifications unless OAuth with `transition:chat.bsky` is added.
- Public notification policy should be named as an inbound/public policy in UI, even if the shared field is `dmPolicy`.
