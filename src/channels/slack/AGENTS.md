# Slack Channel Guide

Keep this integration small, literal, and easy to inspect. The Slack adapter is
an orchestration entrypoint, not a shared utility module.

## Ownership map

- `adapter.ts`: assemble controllers and implement the `ChannelAdapter` surface.
- `ingress-controller.ts`: register Slack events and normalize inbound messages.
- `inbound-debounce.ts`: debounce and deduplicate inbound Slack deliveries.
- `thread-context.ts`: hydrate thread/channel history before listener delivery.
- `status-controller.ts`: own the single mutable assistant status per turn.
- `approval-controller.ts`: post approval widgets and forward button responses.
- `presentation.ts`: build Slack blocks and map progress/error presentation.
- `file-upload.ts` and `media.ts`: outbound upload and inbound media/history.
- `account-display.ts`: resolve the workspace bot display name.
- `agent-thread-tracker.ts`: remember threads in which the agent participated.
- `target-resolution.ts`: resolve proactive MessageChannel destinations.

Import helpers from the module that defines them. Only `plugin.ts` and the test
harness may import `adapter.ts`; do not add forwarding exports to the adapter.

## Progress contract

Slack permanent messages are limited to agent-authored `MessageChannel` output,
approval widgets, and genuine fatal error lines. Thinking, tools, and lifecycle
state render only through `assistant.threads.setStatus`.

- Always provide `loading_messages`; otherwise Slack rotates generic defaults.
- Concrete activity replaces the loading title. Generic/transient activity does
  not overwrite the last concrete title.
- Messages deactivate local status state because Slack clears status on post.
- Reactions do not deactivate status.
- `end_turn` and `cancelled` clear status and post nothing.
- `requires_approval` is a continuation boundary, not a terminal event.
- `tool_rule` is quiet completion. Fatal stop reasons get one plain error line.
- Do not use `chat.startStream`, `chat.appendStream`, or `chat.stopStream` for
  progress. Do not add fallback progress transports.

The listener owns steering and approval buffering. Slack posts the widget,
forwards the click, and updates the widget; it does not implement another queue.

## Tests and verification

Tests live beside their owning Slack module. Keep the fake write client strict:
known-invalid Slack argument combinations must fail rather than silently pass.
Prefer dependency injection; any unavoidable `mock.module()` must preserve every
export and follow the repository mock-isolation rules.

All source and test files must remain at or below 1,000 lines. Split by behavior,
not arbitrary line ranges.

Slack status rendering is invisible to read APIs. Any render-relevant payload
change requires the pairing-DM visual probe on the exact built commit after the
listener restart: startup status, concrete title swaps, pinning, message clear,
reactions, cancellation, fatal error, and the web footnote.
