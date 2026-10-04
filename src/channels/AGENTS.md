# Channels Guide

Rules for changes under `src/channels/`. Read `README.md` here for the plugin
model, account fields, access control, and slash commands. Slack-specific rules
live in `slack/AGENTS.md`; listener turn rules live in
`src/websocket/listener/AGENTS.md`.

## ChannelGateway is the shared policy point

`ChannelGateway` (`gateway-core.ts`) is the common chokepoint for every channel
deployment: on-device channels run it through `gateway-local.ts`, and remote
hosts (for example Letta Cloud) run the same gateway through the
`@letta-ai/letta-code/gateway-core` package export.

Cross-cutting channel behavior — anything phrased as "all channels" or that must
apply to both on-device and Cloud delivery — belongs in the gateway, not
duplicated in adapter-specific routing or conversation-creation code. Before
editing `registry-routes.ts` (or a Cloud-side route handler) for behavior like
source tagging or conversation metadata, check whether the gateway can apply it
where it registers or submits the runtime.

## Pure logic is shared through package subpaths, transport is not

Cloud reuses channel logic through the published subpaths (`channels`,
`channels/slack`, `channels/telegram`, entrypoints `src/channels-public.ts`,
`src/channels-slack.ts`, `src/channels-telegram.ts`). These carry only pure
logic: inbound event validation and normalization, bot-message policy, outbound
payload builders, message-action adapters with injectable transport, and
debounce. They must stay free of node builtins and adapter imports so a browser
or webhook host can run them.

Transport stays deployment-specific: the local adapters own Socket Mode
(Slack) and grammY long polling (Telegram); Cloud supplies its own webhook
receivers and API clients. Do not bundle an adapter and its transport into a
shared module, and do not let a host reimplement its own copy of message,
mention, reaction, or bot-filtering policy — separate ingress algorithms have
already caused Cloud to silently drop events that local channels handled. When
you change ingress or outbound policy in a subpath module, the change is a
published API change consumed by Cloud; check the subpath exports.

## Adapters are orchestration entrypoints

Only a channel's `plugin.ts` and test harness may import its `adapter.ts`
(enforced by `scripts/check-module-ownership.js`). Import helpers from the
module that defines them, and add new pure logic in its own module rather than
growing the adapter.

## Lifecycle errors go through `lifecycle-error.ts`

Never post raw internal errors to a channel: stop reasons ("Unexpected stop
reason: error"), backend CONFLICT/approval JSON, or terminal-only formatting
such as OSC8 hyperlinks from `src/cli/helpers/errorFormatter.ts`. Route
user-visible failure text through `formatChannelLifecycleErrorMessage` in
`lifecycle-error.ts` and normalize new raw payload shapes there, not in one
adapter.

## Channel-origin continuity bugs span backends

When an agent stops replying through `MessageChannel` after compaction or a
context transition, first map which backends are affected: cloud-backed,
containerized, or local. A local-backend prompt tweak is not a production fix
for cloud agents. Prefer backend-agnostic channel-origin metadata or shared
compaction contracts over per-backend patches.
