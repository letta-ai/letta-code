# Discord channel policy consolidation plan

This branch consolidates the overlapping Discord channel work from PR #2045 and PR #2306.

## Direction

- Use PR #2306 as the architectural base for per-channel Discord behavior.
- Keep the per-channel `allowed_channels` mode map instead of the account-level `channelPolicy` field from PR #2045.
- Keep `thread_policy_by_channel`, delivery-time `allowed_channels` enforcement, `parentChannelId`, route reconciliation, and route cleanup gated by `remove_stale_routes`.
- Preserve legacy-safe defaults unless a breaking behavior change is made deliberately in a later PR.
- Port the useful orthogonal pieces from PR #2045: Discord audio transcription and setup-flow coverage for the new options.

## Keep from PR #2306

- `allowed_channels` as either the legacy `string[]` allowlist or a per-channel mode map of `open` / `mention-only`.
- `thread_policy_by_channel` for per-channel mention-thread behavior.
- Delivery-time route gating using `parentChannelId` so stale routes cannot bypass current channel policy.
- `letta channels route reconcile --channel discord` with `--apply` guarded by `remove_stale_routes`.
- Typing indicators for Discord while an agent response is in flight.
- `acknowledge_message_reaction` as an explicit opt-in/out knob.
- Snake-case persisted config migration for newly added account fields.

## Port from PR #2045

- Discord `transcribe_voice` support for inbound audio attachments.
- Discord setup prompts for guild channel mode, mention thread behavior, debounce, reaction acknowledgments, and audio transcription.
- Mention-preserving debounce semantics so an explicit mention in a buffered burst is not lost.

## Fix before opening the PR

- Keep `autoThreadOnMention` defaulting to `false`; Discord thread creation is opt-in.
- Keep `inboundDebounceMs` defaulting to `0` / disabled; open-channel debounce remains opt-in.
- Do not overload `isMention` for open-channel routing; carry `isOpenChannel` separately.
- Remove the unrelated Discord MessageChannel tool-result format change.
- Add/update targeted tests for defaults, routing semantics, transcription, setup config, and websocket/config round trips.
